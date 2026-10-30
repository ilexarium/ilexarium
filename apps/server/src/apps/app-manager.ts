import { Injectable, Logger } from '@nestjs/common';
import {
  APP_ERROR_CODES,
  APP_NAME_PATTERN,
  APPS_FOLDER,
  appsFromContainers,
  type AppDeleteRequest,
  type AppDetails,
  type AppFields,
  type AppInstallRequest,
  type AppNameCheck,
  type AppRemoval,
  type AppRemovalItem,
  type AppSaveRequest,
  type AppStarted,
  type AppSummary,
  type AppTask,
  FILES_ERROR_CODES,
  folderOwner,
  isBackupFolder,
  parseEnv,
  setEnvValues,
} from '@laris/shared';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { AuditService } from '../audit/audit.service.js';
import type { AuditAction } from '../audit/audit-actions.js';
import { CatalogService } from '../catalog/catalog.service.js';
import { DockerService } from '../docker/docker.service.js';
import { filesCode } from '../files/files-errors.js';
import { linuxError } from '../linux-sessions/linux-session-errors.js';
import { LinuxSessions } from '../linux-sessions/linux-sessions.js';
import type { LinuxActor } from '../linux-sessions/linux-sessions.model.js';
import type { Sftp } from '../linux-sessions/sftp.js';
import { appError, helperError } from './app-errors.js';
import { AppTasks } from './app-tasks.js';
import {
  COMPOSE_FILE,
  COMPOSE_FILES,
  ENV_FILE,
  LARIS_DIR,
  LONG_MS,
  QUICK_MS,
  TASKS_DIR,
} from './apps.constants.js';
import type { ComposeFacts, FieldContext } from './apps.model.js';
import { templateFields } from './template-fields.js';

const hashOf = (compose: string, env: string) =>
  createHash('sha256').update(compose).update('\0').update(env).digest('hex');

/**
 * Never offered for deletion: a system path an app mounts (`/etc/localtime`, the Docker socket),
 * nor the account's home or a folder above it (Compose turns `~` into the home).
 */
const deletable = (facts: ComposeFacts, home: string): ComposeFacts => ({
  ...facts,
  folders: facts.folders.filter(
    (path) => isBackupFolder(path) && path !== home && !inside(home, path),
  ),
});

const inside = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

/**
 * Apps (docs/plans/acting_as_you.md): Compose folders run as the signed-in Linux account. The list
 * comes from Docker (no sign-in needed); everything else is read and done as the person — their
 * files over SFTP, Compose through their helper, long tasks as units. Audited as the person, by
 * name and folder, never values.
 */
@Injectable()
export class AppManager {
  private readonly logger = new Logger(AppManager.name);

  constructor(
    private readonly dockerService: DockerService,
    private readonly catalogService: CatalogService,
    private readonly linuxSessions: LinuxSessions,
    private readonly appTasks: AppTasks,
    private readonly auditService: AuditService,
  ) {}

  /** The apps Docker knows, and with a Linux session those in `~/apps` that don't run. */
  async list(appSessionId: string): Promise<AppSummary[]> {
    const containers = await this.dockerService.listContainers().catch(() => []);
    const apps = appsFromContainers(containers, (id) => this.catalogService.webPort(id));
    const session = this.linuxSessions.current(appSessionId);
    if (!session) return apps;
    const sftp = this.sftp(appSessionId);
    const root = posix.join(session.home, APPS_FOLDER);
    for (const name of await sftp.list(root).catch(() => [])) {
      if (!APP_NAME_PATTERN.test(name) || apps.some((app) => app.name === name)) continue;
      const folder = posix.join(root, name);
      if (!(await this.composeFileIn(sftp, folder))) continue;
      apps.push({
        name,
        folder,
        owner: folderOwner(folder),
        template: null,
        state: 'none',
        containers: [],
        webPort: null,
      });
    }
    return apps.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Free: no Compose project and no folder in `~/apps` of that name. */
  async checkName(appSessionId: string, name: string): Promise<AppNameCheck> {
    const taken = new Set(
      (await this.dockerService.listContainers().catch(() => []))
        .map((c) => c.composeProject)
        .filter((p): p is string => p !== null),
    );
    const session = this.linuxSessions.current(appSessionId);
    if (session) {
      for (const folder of await this.sftp(appSessionId)
        .list(posix.join(session.home, APPS_FOLDER))
        .catch(() => [])) {
        taken.add(folder);
      }
    }
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^[^a-z0-9]+/, '')
        .slice(0, 56) || 'app';
    let suggestion = base;
    for (let n = 2; taken.has(suggestion); n++) suggestion = `${base}-${n}`;
    return { free: APP_NAME_PATTERN.test(name) && !taken.has(name), suggestion };
  }

  /** A template's setup form. */
  fields(appSessionId: string, templateId: string): AppFields {
    const { template } = this.catalogService.require(templateId);
    return { fields: templateFields(template, '', this.context(appSessionId)) };
  }

  async install(
    appSessionId: string,
    request: AppInstallRequest,
    actor: LinuxActor,
  ): Promise<AppStarted> {
    const account = this.linuxSessions.account(appSessionId);
    const sftp = this.sftp(appSessionId);
    const folder = request.folder ?? posix.join(account.home, APPS_FOLDER, request.name);
    if (!(await this.checkName(appSessionId, request.name)).free) {
      throw appError(APP_ERROR_CODES.nameTaken, 'An app of this name exists');
    }
    if ((await sftp.list(folder)).length > 0) {
      throw appError(APP_ERROR_CODES.folderExists, 'That folder is not empty');
    }
    await this.sudoFirst(appSessionId);
    const details = {
      name: request.name,
      folder,
      ...(request.template && { template: request.template }),
    };
    return this.audited('app.install', actor, details, async () => {
      const created = await sftp.makeFolders(folder);
      const written: string[] = [];
      try {
        await sftp.writeText(posix.join(folder, COMPOSE_FILE), request.compose, 0o644);
        written.push(posix.join(folder, COMPOSE_FILE));
        await sftp.writeText(
          posix.join(folder, ENV_FILE),
          this.withAccount(appSessionId, request.template, request.env),
          0o600,
        );
        written.push(posix.join(folder, ENV_FILE));
        const facts = await this.appTasks.check(appSessionId, folder, request.name);
        created.push(...(await this.makeDataFolders(sftp, facts.folders)));
        const task = await this.appTasks.start(appSessionId, folder, request.name, 'up');
        return { name: request.name, folder, task };
      } catch (error) {
        // Nothing left behind of a setup that didn't start: the person fixes the form and tries again.
        for (const file of written) await sftp.remove(file).catch(() => undefined);
        await sftp.remove(posix.join(folder, LARIS_DIR, 'task.json')).catch(() => undefined);
        // The helper's folders for a task that didn't start (empty: only those go).
        for (const dir of [TASKS_DIR, LARIS_DIR]) {
          await sftp.removeFolder(posix.join(folder, dir)).catch(() => undefined);
        }
        for (const dir of [...created].reverse()) {
          await sftp.removeFolder(dir).catch(() => undefined);
        }
        throw error;
      }
    });
  }

  async details(appSessionId: string, name: string, folderHint?: string): Promise<AppDetails> {
    const sftp = this.sftp(appSessionId);
    const { folder, summary } = await this.locate(appSessionId, name, folderHint);
    const files = await this.readFiles(sftp, folder);
    // Not running: the label from the files, as Compose reads them (none while they're invalid).
    const [facts, task] = await Promise.all([
      summary.template ? null : this.appTasks.check(appSessionId, folder, name).catch(() => null),
      this.appTasks.read(appSessionId, sftp, folder),
    ]);
    const label = summary.template ?? facts?.template ?? null;
    const entry = label ? this.catalogService.get(label.id) : undefined;
    return {
      app: { ...summary, template: label },
      folder,
      compose: files.compose,
      env: files.env,
      hash: hashOf(files.compose, files.env),
      fields: entry ? templateFields(entry.template, files.env, this.context(appSessionId)) : [],
      template: label,
      task,
    };
  }

  async task(
    appSessionId: string,
    name: string,
    folderHint: string | undefined,
  ): Promise<AppTask | null> {
    const { folder } = await this.locate(appSessionId, name, folderHint);
    return this.appTasks.read(appSessionId, this.sftp(appSessionId), folder);
  }

  /** Saves both files and applies them (`up`); refused when they changed on disk meanwhile. */
  async save(
    appSessionId: string,
    name: string,
    request: AppSaveRequest,
    actor: LinuxActor,
  ): Promise<AppStarted> {
    const sftp = this.sftp(appSessionId);
    const folder = request.folder;
    const files = await this.readFiles(sftp, folder);
    if (!request.overwrite && hashOf(files.compose, files.env) !== request.hash) {
      throw appError(APP_ERROR_CODES.changedOnDisk, 'The files changed on disk');
    }
    await this.notBusy(appSessionId, sftp, folder);
    await this.sudoFirst(appSessionId);
    return this.audited('app.change', actor, { name, folder }, async () => {
      const composePath = posix.join(folder, files.composeName);
      const envPath = posix.join(folder, ENV_FILE);
      try {
        await sftp.writeText(composePath, request.compose, 0o644);
        await sftp.writeText(envPath, request.env, 0o600);
        const facts = await this.appTasks.check(appSessionId, folder, name);
        await this.makeDataFolders(sftp, facts.folders);
        const task = await this.appTasks.start(appSessionId, folder, name, 'up');
        return { name, folder, task };
      } catch (error) {
        // Not applied: the files as they were, so the form's next try isn't "changed on disk".
        await sftp.writeText(composePath, files.compose, 0o644).catch(() => undefined);
        await sftp.writeText(envPath, files.env, 0o600).catch(() => undefined);
        throw error;
      }
    });
  }

  /** Update: pull and start again. The way back is the app's backup from before. */
  async update(
    appSessionId: string,
    name: string,
    folder: string,
    actor: LinuxActor,
  ): Promise<AppStarted> {
    const sftp = this.sftp(appSessionId);
    await this.notBusy(appSessionId, sftp, folder);
    await this.sudoFirst(appSessionId);
    return this.audited('app.update', actor, { name, folder }, async () => {
      await this.appTasks.check(appSessionId, folder, name);
      const task = await this.appTasks.start(appSessionId, folder, name, 'update');
      return { name, folder, task };
    });
  }

  /** Its files as they are, applied (`up -d`) — after a restore back where it was. */
  async apply(
    appSessionId: string,
    name: string,
    folder: string,
    actor: LinuxActor,
  ): Promise<AppStarted> {
    const sftp = this.sftp(appSessionId);
    await this.notBusy(appSessionId, sftp, folder);
    await this.sudoFirst(appSessionId);
    return this.audited('app.change', actor, { name, folder }, async () => {
      await this.appTasks.check(appSessionId, folder, name);
      const task = await this.appTasks.start(appSessionId, folder, name, 'up');
      return { name, folder, task };
    });
  }

  /** What a removal may delete: the settings, each data folder, each named volume — with sizes. */
  async removal(appSessionId: string, name: string, folder: string): Promise<AppRemoval> {
    await this.readFiles(this.sftp(appSessionId), folder);
    const mounts = deletable(
      await this.appTasks.check(appSessionId, folder, name),
      this.linuxSessions.account(appSessionId).home,
    );
    const paths = [folder, ...mounts.folders.filter((path) => path !== folder)];
    const answer = await this.linuxSessions.ask(
      appSessionId,
      { action: 'paths.size', paths },
      { timeoutMs: LONG_MS },
    );
    const sizes = answer.ok ? (answer['sizes'] as Record<string, { bytes: number | null }>) : {};
    const items: AppRemovalItem[] = [
      { kind: 'settings', path: folder, bytes: null, outside: false },
      // Its own folders first, then the ones outside (may be used elsewhere).
      ...mounts.folders
        .filter((path) => path !== folder)
        .sort((a, b) => Number(!inside(a, folder)) - Number(!inside(b, folder)))
        .map((path) => ({
          kind: 'folder' as const,
          path,
          bytes: sizes[path]?.bytes ?? null,
          outside: !inside(path, folder),
        })),
      ...mounts.volumes.map((volume) => ({
        kind: 'volume' as const,
        path: volume,
        bytes: null,
        outside: false,
      })),
    ];
    return { items };
  }

  /** `docker compose down`, as a task; what to delete comes after it, with `delete`. */
  async remove(
    appSessionId: string,
    name: string,
    folder: string,
    actor: LinuxActor,
  ): Promise<AppStarted> {
    const sftp = this.sftp(appSessionId);
    await this.notBusy(appSessionId, sftp, folder);
    return this.audited('app.remove', actor, { name, folder }, async () => {
      const task = await this.appTasks.start(appSessionId, folder, name, 'down');
      return { name, folder, task };
    });
  }

  /**
   * After the removal's `down`: deletes what the person ticked — as them, through their sudo for
   * what containers wrote as another user. Every inside folder and the settings ticked: the whole
   * app folder goes.
   */
  async delete(
    appSessionId: string,
    name: string,
    request: AppDeleteRequest,
    actor: LinuxActor,
  ): Promise<void> {
    const sftp = this.sftp(appSessionId);
    const { folder } = request;
    const task = await this.appTasks.read(appSessionId, sftp, folder);
    if (task?.action !== 'down' || task.state !== 'succeeded') {
      throw appError(APP_ERROR_CODES.taskRunning, 'Remove the app first');
    }
    const files = await this.readFiles(sftp, folder);
    const mounts = deletable(
      await this.appTasks.check(appSessionId, folder, name),
      this.linuxSessions.account(appSessionId).home,
    );
    // Only what the removal listed: never another path.
    const folders = request.folders.filter(
      (path) => mounts.folders.includes(path) && path !== folder,
    );
    const volumes = request.volumes.filter((volume) => mounts.volumes.includes(volume));
    const insideAll = mounts.folders
      .filter((path) => path !== folder && inside(path, folder))
      .every((path) => folders.includes(path));
    const details = {
      name,
      folder,
      folders: folders.length,
      volumes: volumes.length,
      settings: request.settings,
    };
    await this.audited('app.delete', actor, details, async () => {
      // The data first, the app's own files last: when a container's files need sudo, the files
      // this request is checked against stay, and the retry after the sudo prompt can go on (the
      // folders already gone are no error, so they go before the volumes).
      if (folders.length > 0) await this.removePaths(appSessionId, folders);
      if (volumes.length > 0) {
        const access = await this.appTasks.dockerAccess(appSessionId);
        const answer = await this.linuxSessions.ask(
          appSessionId,
          { action: 'volumes.remove', names: volumes, docker: access.quick },
          { sudo: access.quick === 'sudo', timeoutMs: QUICK_MS },
        );
        if (!answer.ok) throw helperError(answer);
      }
      if (request.settings) {
        await this.removePaths(
          appSessionId,
          insideAll
            ? [folder]
            : [
                posix.join(folder, files.composeName),
                posix.join(folder, ENV_FILE),
                posix.join(folder, LARIS_DIR),
              ],
        );
      }
      return null;
    });
  }

  /** As the account first; what it may not delete (a container's files) through its sudo. */
  private async removePaths(appSessionId: string, paths: string[]): Promise<void> {
    const own = await this.linuxSessions.ask(
      appSessionId,
      { action: 'paths.remove', paths, administrator: false },
      { timeoutMs: LONG_MS },
    );
    if (own.ok) return;
    if (own.error !== 'not_permitted') throw helperError(own);
    const root = await this.linuxSessions.ask(
      appSessionId,
      { action: 'paths.remove', paths, administrator: true },
      { sudo: true, timeoutMs: LONG_MS },
    );
    if (!root.ok) throw helperError(root);
  }

  // Helpers.

  private sftp(appSessionId: string): Sftp {
    return this.linuxSessions.sftp(appSessionId).sftp;
  }

  /** A template's `@account` fields left empty (the form came before the sign-in): this account. */
  private withAccount(appSessionId: string, templateId: string | null, env: string): string {
    const template = templateId ? this.catalogService.get(templateId)?.template : undefined;
    const values = parseEnv(env);
    const empty = (template?.fields ?? [])
      .filter((field) => field.default === '@account' && !values.get(field.key))
      .map((field) => field.key);
    if (empty.length === 0) return env;
    const { account } = this.context(appSessionId);
    return setEnvValues(env, Object.fromEntries(empty.map((key) => [key, account])));
  }

  private context(appSessionId: string): FieldContext {
    const session = this.linuxSessions.current(appSessionId);
    // Never a guess: an account's uid is known only once signed in, and install fills it then.
    let account = '';
    if (session) {
      const { uid, gid } = this.linuxSessions.account(appSessionId);
      if (uid !== null) account = `${uid}:${gid ?? uid}`;
    }
    return { account, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' };
  }

  /** Where an app's folder is: Docker's label, else the hint, else `~/apps/<name>`. */
  private async locate(
    appSessionId: string,
    name: string,
    hint?: string,
  ): Promise<{ folder: string; summary: AppSummary }> {
    const containers = await this.dockerService.listContainers().catch(() => []);
    const known = appsFromContainers(containers, (id) => this.catalogService.webPort(id)).find(
      (app) => app.name === name,
    );
    const home = this.linuxSessions.account(appSessionId).home;
    const folder = known?.folder ?? hint ?? posix.join(home, APPS_FOLDER, name);
    const summary: AppSummary = known ?? {
      name,
      folder,
      owner: folderOwner(folder),
      template: null,
      state: 'none',
      containers: [],
      webPort: null,
    };
    return { folder, summary };
  }

  private async composeFileIn(sftp: Sftp, folder: string): Promise<string | null> {
    const names = await sftp.list(folder);
    return COMPOSE_FILES.find((name) => names.includes(name)) ?? null;
  }

  private async readFiles(
    sftp: Sftp,
    folder: string,
  ): Promise<{ compose: string; env: string; composeName: string }> {
    const composeName = await this.composeFileIn(sftp, folder).catch((error: unknown) => {
      if (filesCode(error) === FILES_ERROR_CODES.permissionDenied) throw error;
      return null;
    });
    if (!composeName) throw appError(APP_ERROR_CODES.notFound, 'No Compose file in this folder');
    const compose = (await sftp.readText(posix.join(folder, composeName), 256 * 1024)) ?? '';
    const env = (await sftp.readText(posix.join(folder, ENV_FILE), 256 * 1024)) ?? '';
    return { compose, env, composeName };
  }

  /** Folders a Compose file mounts that don't exist yet: made as the person (Docker would make them as root). */
  private async makeDataFolders(sftp: Sftp, folders: string[]): Promise<string[]> {
    const created: string[] = [];
    for (const path of folders) {
      // A file mounted (a config file) is the person's to create; only folders without a dot-name are made.
      if (/\.[a-z0-9]{1,5}$/i.test(path)) continue;
      created.push(...(await sftp.makeFolders(path).catch(() => [])));
    }
    return created;
  }

  /** Without the docker group a task starts through sudo: asked before anything is written. */
  private async sudoFirst(appSessionId: string): Promise<void> {
    const access = await this.appTasks.dockerAccess(appSessionId);
    const account = this.linuxSessions.account(appSessionId);
    if ((access.system || access.quick === 'sudo') && !account.sudoUnlocked) {
      throw linuxError(FILES_ERROR_CODES.sudoRequired, 'sudo is locked');
    }
  }

  private async notBusy(appSessionId: string, sftp: Sftp, folder: string): Promise<void> {
    const task = await this.appTasks.read(appSessionId, sftp, folder);
    if (task?.state === 'running') throw appError(APP_ERROR_CODES.taskRunning, 'A task is running');
  }

  /** `requested` first (no record, no action), then the outcome — like every change as the person. */
  private async audited<T>(
    action: AuditAction,
    actor: LinuxActor,
    details: Record<string, string | number | boolean>,
    act: () => Promise<T>,
  ): Promise<T> {
    const entry = (outcome: 'requested' | 'success' | 'failure', reason?: string) => ({
      action,
      outcome,
      userId: actor.user.id,
      username: actor.user.username,
      ip: actor.ip,
      details: { ...details, ...(reason && { reason }) },
    });
    try {
      await this.auditService.record(entry('requested'));
    } catch {
      throw linuxError(FILES_ERROR_CODES.auditUnavailable, 'The audit log is unavailable');
    }
    try {
      const result = await act();
      await this.auditService.tryRecord(entry('success'));
      return result;
    } catch (error) {
      const code = filesCode(error) ?? 'failed';
      await this.auditService.tryRecord(entry('failure', code));
      if (code === 'failed')
        this.logger.warn(`${action} ${details['name']}: ${(error as Error).message}`);
      throw error;
    }
  }
}
