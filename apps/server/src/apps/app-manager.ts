import { Injectable, Logger } from '@nestjs/common';
import {
  APP_ERROR_CODES,
  APP_NAME_PATTERN,
  APPS_FOLDER,
  appsFromContainers,
  type AppBeforeUpdate,
  type AppDeleteRequest,
  type AppDetails,
  type AppFields,
  type AppFieldsRequest,
  type AppImageTagRequest,
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
  TEMPLATE_LABEL_PATTERN,
} from '@laris/shared';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { parse } from 'yaml';
import { AuditService } from '../audit/audit.service.js';
import type { AuditAction } from '../audit/audit-actions.js';
import { CatalogService } from '../catalog/catalog.service.js';
import { DockerService } from '../docker/docker.service.js';
import { filesCode } from '../files/files-errors.js';
import { linuxError } from '../linux-sessions/linux-session-errors.js';
import { LinuxSessions } from '../linux-sessions/linux-sessions.js';
import type { LinuxActor } from '../linux-sessions/linux-sessions.model.js';
import { appError, helperError } from './app-errors.js';
import { AppSftp } from './app-sftp.js';
import { AppTasks } from './app-tasks.js';
import {
  BEFORE_UPDATE_FILE,
  COMPOSE_FILE,
  COMPOSE_FILES,
  ENV_FILE,
  KEPT_FILE,
  LARIS_DIR,
  LONG_MS,
  QUICK_MS,
} from './apps.constants.js';
import type { FieldContext } from './apps.model.js';
import { composeFields, splitImage, variablesIn } from './compose-fields.js';
import { withImageTag } from './image-tag.js';

const hashOf = (compose: string, env: string) =>
  createHash('sha256').update(compose).update('\0').update(env).digest('hex');

interface ComposeMounts {
  folders: string[];
  volumes: string[];
}

/** Never offered for deletion: a system path an app mounts (`/etc/localtime`, the Docker socket). */
const deletable = (mounts: ComposeMounts): ComposeMounts => ({
  ...mounts,
  folders: mounts.folders.filter(isBackupFolder),
});

const inside = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

/** A value with its `${VARIABLES}` filled from `.env` (or their defaults), as Compose does. */
export function interpolate(text: string, values: ReadonlyMap<string, string>): string {
  let out = '';
  let last = 0;
  for (const use of variablesIn(text)) {
    out += text.slice(last, use.at).replace(/\$\$/g, '$');
    const value = values.get(use.key);
    out += value !== undefined && value !== '' ? value : (use.default ?? '');
    last = use.end;
  }
  return out + text.slice(last).replace(/\$\$/g, '$');
}

/** The bind-mounted folders and named volumes a Compose file uses, its variables filled in. */
export function composeMounts(
  compose: string,
  env: string,
  folder: string,
  project: string,
): ComposeMounts {
  let file: {
    services?: Record<string, { volumes?: unknown[] }>;
    volumes?: Record<string, { name?: unknown; external?: unknown } | null>;
  } | null;
  try {
    file = parse(compose, { maxAliasCount: 100, uniqueKeys: false }) as typeof file;
  } catch {
    return { folders: [], volumes: [] };
  }
  const values = parseEnv(env);
  const folders = new Set<string>();
  const named = new Set<string>();
  for (const service of Object.values(file?.services ?? {})) {
    for (const entry of service?.volumes ?? []) {
      let source: string | null = null;
      let bind = false;
      if (typeof entry === 'string') {
        const filled = interpolate(entry, values);
        // `- /var/lib/mysql` alone is an anonymous volume inside the container, not a host folder.
        if (!filled.includes(':')) continue;
        source = filled.split(':')[0] ?? null;
        bind = /^[/.~]/.test(source ?? '');
      } else if (entry && typeof entry === 'object') {
        const long = entry as { type?: unknown; source?: unknown };
        if (typeof long.source === 'string') {
          source = interpolate(long.source, values);
          bind = long.type === 'bind' || /^[/.~]/.test(source);
        }
      }
      if (!source) continue;
      if (bind) {
        if (source.startsWith('~')) continue; // Compose's own home: not one to guess
        folders.add(posix.resolve(folder, source));
      } else {
        named.add(source);
      }
    }
  }
  const volumes: string[] = [];
  for (const key of named) {
    const definition = file?.volumes?.[key];
    if (definition && definition.external) continue;
    const name = typeof definition?.name === 'string' ? interpolate(definition.name, values) : null;
    volumes.push(name ?? `${project}_${key}`);
  }
  return { folders: [...folders].sort(), volumes: volumes.sort() };
}

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

  /** The setup form of a file (a template's or a pasted one). */
  fields(appSessionId: string, request: AppFieldsRequest): AppFields {
    const template = request.template
      ? this.catalogService.require(request.template).template
      : null;
    return composeFields(request.compose, request.env, template, this.context(appSessionId));
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
        await sftp.writeText(posix.join(folder, ENV_FILE), request.env, 0o600);
        written.push(posix.join(folder, ENV_FILE));
        created.push(...(await this.makeDataFolders(sftp, request.compose, request.env, folder)));
        await this.appTasks.check(appSessionId, folder, request.name);
        const task = await this.appTasks.start(appSessionId, folder, request.name, 'up');
        return { name: request.name, folder, task };
      } catch (error) {
        // Nothing left behind of a setup that didn't start: the person fixes the form and tries again.
        for (const file of written) await sftp.remove(file).catch(() => undefined);
        await sftp.remove(posix.join(folder, LARIS_DIR, 'task.json')).catch(() => undefined);
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
    const label = summary.template ?? this.labelIn(files.compose);
    const entry = label ? this.catalogService.get(label.id) : undefined;
    const fields = composeFields(
      files.compose,
      files.env,
      entry?.template ?? null,
      this.context(appSessionId),
    );
    const names = await sftp.list(folder);
    return {
      app: { ...summary, template: label },
      folder,
      compose: files.compose,
      env: files.env,
      hash: hashOf(files.compose, files.env),
      ...fields,
      template: label ? { ...label, current: entry?.template.version ?? null } : null,
      task: await this.appTasks.read(appSessionId, sftp, folder),
      beforeUpdate: await this.beforeUpdate(sftp, folder),
      keptFiles: names.filter((n) => KEPT_FILE.test(n)).sort(),
    };
  }

  async task(
    appSessionId: string,
    name: string,
    folderHint: string | undefined,
    from: number,
  ): Promise<AppTask | null> {
    const { folder } = await this.locate(appSessionId, name, folderHint);
    return this.appTasks.read(appSessionId, this.sftp(appSessionId), folder, from);
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
        await this.makeDataFolders(sftp, request.compose, request.env, folder);
        await this.appTasks.check(appSessionId, folder, name);
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

  /** Update: the running digests saved first (the way back), then pull and start again. */
  async update(
    appSessionId: string,
    name: string,
    folder: string,
    actor: LinuxActor,
    details: Record<string, string> = {},
    prepare?: () => Promise<void>,
  ): Promise<AppStarted> {
    const sftp = this.sftp(appSessionId);
    await this.notBusy(appSessionId, sftp, folder);
    await this.sudoFirst(appSessionId);
    return this.audited('app.update', actor, { name, folder, ...details }, async () => {
      await prepare?.();
      await this.saveDigests(appSessionId, sftp, folder, name);
      await this.appTasks.check(appSessionId, folder, name);
      const task = await this.appTasks.start(appSessionId, folder, name, 'update');
      return { name, folder, task };
    });
  }

  /** A pasted file's fixed tag changed in its `image:` line (comments kept), then Update. */
  async imageTag(
    appSessionId: string,
    name: string,
    request: AppImageTagRequest,
    actor: LinuxActor,
  ): Promise<AppStarted> {
    const sftp = this.sftp(appSessionId);
    const files = await this.readFiles(sftp, request.folder);
    const changed = withImageTag(files.compose, request.service, request.tag);
    if (changed === null)
      throw appError(APP_ERROR_CODES.serviceNotFound, 'No such service or image line');
    const composePath = posix.join(request.folder, files.composeName);
    // Written only once recorded and nothing else runs; put back if the update doesn't start.
    let written = false;
    try {
      return await this.update(
        appSessionId,
        name,
        request.folder,
        actor,
        { service: request.service, tag: request.tag },
        async () => {
          await sftp.writeText(composePath, changed, 0o644);
          written = true;
        },
      );
    } catch (error) {
      if (written) await sftp.writeText(composePath, files.compose, 0o644).catch(() => undefined);
      throw error;
    }
  }

  /**
   * "Use the current template": the old file kept beside it, the template's written, `.env` kept
   * with the new variables added (defaults, new secrets). The person looks, then updates.
   */
  async useTemplate(
    appSessionId: string,
    name: string,
    folder: string,
    actor: LinuxActor,
  ): Promise<AppDetails> {
    const sftp = this.sftp(appSessionId);
    const files = await this.readFiles(sftp, folder);
    const label =
      this.labelIn(files.compose) ??
      (await this.locate(appSessionId, name, folder)).summary.template;
    if (!label) throw appError(APP_ERROR_CODES.templateNotFound, 'This app has no template');
    const entry = this.catalogService.require(label.id);
    await this.audited(
      'app.change',
      actor,
      { name, folder, template: `${label.id}@${entry.template.version}` },
      async () => {
        const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const names = await sftp.list(folder);
        let kept = `${files.composeName}.before-template-${date}`;
        for (let n = 2; names.includes(kept); n++)
          kept = `${files.composeName}.before-template-${date}-${n}`;
        await sftp.rename(posix.join(folder, files.composeName), posix.join(folder, kept));
        await sftp.writeText(posix.join(folder, files.composeName), entry.compose, 0o644);
        const known = parseEnv(files.env);
        const added: Record<string, string> = {};
        for (const field of composeFields(
          entry.compose,
          files.env,
          entry.template,
          this.context(appSessionId),
        ).fields) {
          if (!known.has(field.key)) added[field.key] = field.value;
        }
        await sftp.writeText(posix.join(folder, ENV_FILE), setEnvValues(files.env, added), 0o600);
        return null;
      },
    );
    return this.details(appSessionId, name, folder);
  }

  /** What a removal may delete: the settings, each data folder, each named volume — with sizes. */
  async removal(appSessionId: string, name: string, folder: string): Promise<AppRemoval> {
    const sftp = this.sftp(appSessionId);
    const files = await this.readFiles(sftp, folder);
    const mounts = deletable(composeMounts(files.compose, files.env, folder, name));
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
    const mounts = deletable(composeMounts(files.compose, files.env, folder, name));
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
      if (volumes.length > 0) {
        const access = await this.appTasks.dockerAccess(appSessionId);
        const answer = await this.linuxSessions.ask(
          appSessionId,
          { action: 'volumes.remove', names: volumes, docker: access.quick },
          { sudo: access.quick === 'sudo', timeoutMs: QUICK_MS },
        );
        if (!answer.ok) throw helperError(answer);
      }
      const whole = request.settings && insideAll;
      const targets = whole
        ? [folder, ...folders.filter((path) => !inside(path, folder))]
        : [
            ...folders,
            ...(request.settings
              ? [
                  posix.join(folder, files.composeName),
                  posix.join(folder, ENV_FILE),
                  posix.join(folder, LARIS_DIR),
                ]
              : []),
          ];
      if (targets.length > 0) await this.removePaths(appSessionId, targets);
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

  private sftp(appSessionId: string): AppSftp {
    return new AppSftp(this.linuxSessions.sftp(appSessionId).sftp);
  }

  private context(appSessionId: string): FieldContext {
    const session = this.linuxSessions.current(appSessionId);
    let account = '1000:1000';
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

  private async composeFileIn(sftp: AppSftp, folder: string): Promise<string | null> {
    const names = await sftp.list(folder);
    return COMPOSE_FILES.find((name) => names.includes(name)) ?? null;
  }

  private async readFiles(
    sftp: AppSftp,
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

  private labelIn(compose: string): { id: string; version: string } | null {
    const match = /laris\.template['"]?\s*[:=]\s*['"]?([a-z0-9][a-z0-9-]{0,39}@[0-9]{1,6})/.exec(
      compose,
    );
    const parts = match ? TEMPLATE_LABEL_PATTERN.exec(match[1]) : null;
    return parts ? { id: parts[1], version: parts[2] } : null;
  }

  /** Folders a Compose file mounts that don't exist yet: made as the person (Docker would make them as root). */
  private async makeDataFolders(
    sftp: AppSftp,
    compose: string,
    env: string,
    folder: string,
  ): Promise<string[]> {
    const created: string[] = [];
    for (const path of composeMounts(compose, env, folder, 'app').folders) {
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

  private async notBusy(appSessionId: string, sftp: AppSftp, folder: string): Promise<void> {
    const task = await this.appTasks.read(appSessionId, sftp, folder, Number.MAX_SAFE_INTEGER);
    if (task?.state === 'running') throw appError(APP_ERROR_CODES.taskRunning, 'A task is running');
  }

  private async beforeUpdate(sftp: AppSftp, folder: string): Promise<AppBeforeUpdate | null> {
    const text = await sftp
      .readText(posix.join(folder, BEFORE_UPDATE_FILE), 64 * 1024)
      .catch(() => null);
    if (!text) return null;
    try {
      return JSON.parse(text) as AppBeforeUpdate;
    } catch {
      return null;
    }
  }

  /** `.laris/before-update.json`: each service's image, tag and the digest it ran. */
  private async saveDigests(
    appSessionId: string,
    sftp: AppSftp,
    folder: string,
    project: string,
  ): Promise<void> {
    const access = await this.appTasks.dockerAccess(appSessionId);
    const answer = await this.linuxSessions.ask(
      appSessionId,
      { action: 'compose.images', folder, project, docker: access.quick },
      { sudo: access.quick === 'sudo', timeoutMs: QUICK_MS },
    );
    if (!answer.ok) {
      // Nothing running yet (no images): nothing to go back to.
      if (answer.error === 'compose_failed') return;
      throw helperError(answer);
    }
    const images = (
      answer['images'] as {
        container: string;
        repository: string;
        tag: string;
        digests: string[];
      }[]
    )
      .map((image) => {
        const digest =
          image.digests.find((d) => splitImage(d).image === image.repository) ?? image.digests[0];
        // `compose images` names the container, not the service: the undo matches by image.
        const service = image.container;
        return digest
          ? { service, image: image.repository, tag: image.tag, digest: digest.split('@')[1] ?? '' }
          : null;
      })
      .filter(
        (image): image is AppBeforeUpdate['images'][number] =>
          image !== null && image.digest !== '',
      );
    if (images.length === 0) return;
    const record: AppBeforeUpdate = { at: new Date().toISOString(), images };
    await sftp.makeFolders(posix.join(folder, LARIS_DIR), 0o700);
    await sftp.writeText(
      posix.join(folder, BEFORE_UPDATE_FILE),
      `${JSON.stringify(record, null, 2)}\n`,
      0o600,
    );
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
