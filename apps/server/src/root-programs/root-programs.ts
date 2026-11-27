import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FILES_ERROR_CODES } from '@ilex/shared';
import { spawn } from 'node:child_process';
import { AuditService } from '../audit/audit.service.js';
import type { AuditAction } from '../audit/audit-actions.js';
import type { Env } from '../config/env.schema.js';
import { linuxError } from '../linux-sessions/linux-session-errors.js';
import { LinuxSessions } from '../linux-sessions/linux-sessions.js';
import { SUDO_ERRORS } from '../linux-sessions/linux-sessions.constants.js';
import { LineSplitter, cleanLine, parseWrapperLine } from './output.js';
import { ProgramConfigService } from './program-config.js';
import {
  ANSWER_MARGIN_MS,
  BACKUP,
  BACKUP_LONG_TIMEOUT_MS,
  BACKUP_TASK_TIMEOUT_MS,
  DISK,
  DISK_TIMEOUT_MS,
  PATH,
  PROGRAM_FILES,
  UPDATE,
  UPDATE_START_TIMEOUT_MS,
} from './root-programs.constants.js';
import type {
  BackupOutcome,
  DiskOutcome,
  ProgramBackupPlan,
  ProgramKind,
  ProgramRecoverCheck,
  ProgramRestoreInput,
  RootActor,
  UpdateStartOutcome,
} from './root-programs.model.js';

/** `recover-check`'s answer, checked: the newest backup of Ilexarium there. */
function readRecoverCheck(
  result: Record<string, unknown> | undefined,
): ProgramRecoverCheck | undefined {
  const archive = result?.['archive'] as Record<string, unknown> | undefined;
  return typeof archive?.['name'] === 'string' && typeof archive['time'] === 'string'
    ? { archive: { name: archive['name'], time: archive['time'] } }
    : undefined;
}

/** What one run printed and how it ended, before it means anything. */
interface RawRun {
  exitCode: number | null;
  /** It never started (no such program, or sudo refused it). */
  notStarted: boolean;
  timedOut: boolean;
  lastError: string | null;
  /** Its `@@result` objects, in order. */
  results: Record<string, unknown>[];
  /** Its last `@@info` line: why it refused (logged with an unexpected refusal). */
  lastInfo: string | null;
}

type Result<Code extends string, T> =
  { ok: true; value: T } | { ok: false; code: Code; value: T | null };

/**
 * The root programs (ilex-backup, ilex-disk, ilex-update): started through the
 * signed-in person's own sudo, by their helper — Ilexarium holds no root. Every call records the
 * request in the audit log first (no record, no run), then runs the program (values on stdin)
 * and records the outcome. A locked sudo is a 403 `sudo_required`: the web app asks for the
 * password and carries on. Development (`ROOT_PROGRAMS=direct`, refused in production) runs the
 * repository's program directly, as the developer.
 */
@Injectable()
export class RootPrograms {
  private readonly logger = new Logger(RootPrograms.name);
  private readonly direct: boolean;

  constructor(
    config: ConfigService<Env, true>,
    private readonly auditService: AuditService,
    private readonly programConfig: ProgramConfigService,
    private readonly linuxSessions: LinuxSessions,
  ) {
    this.direct = config.get('ROOT_PROGRAMS', { infer: true }) === 'direct';
  }

  /** Writes the plan for the timer (the program checks it all again). */
  backupConfigure(plan: ProgramBackupPlan, actor: RootActor): Promise<BackupOutcome<null>> {
    return this.backup('configure', actor, 'backup.configure', plan, {
      audit: { destination: plan.destination, items: plan.items.length },
      read: () => null,
    });
  }

  /** Creates the repository (and the passphrase, the first time) on the chosen disk. */
  backupInit(
    destination: string,
    actor: RootActor,
  ): Promise<BackupOutcome<{ repositoryId: string; created: boolean }>> {
    return this.backup(
      'init',
      actor,
      'backup.init',
      { destination },
      {
        audit: { destination },
        read: (result) =>
          typeof result?.['repositoryId'] === 'string'
            ? { repositoryId: result['repositoryId'], created: result['created'] === true }
            : undefined,
      },
    );
  }

  /** "Back up now": systemd starts the run as its own unit; returns at once. */
  backupStart(
    input: { runId: string; itemId?: string },
    actor: RootActor,
  ): Promise<BackupOutcome<null>> {
    return this.backup('start', actor, 'backup.run', input, {
      audit: { ...input },
      read: () => null,
    });
  }

  /** A restore: systemd starts it as its own unit (`ilex-restore@<id>`); returns at once. */
  backupRestoreStart(input: ProgramRestoreInput, actor: RootActor): Promise<BackupOutcome<null>> {
    return this.backup('restore-start', actor, 'backup.restore', input, {
      audit: {
        restoreId: input.restoreId,
        itemId: input.itemId,
        archive: input.archive,
        target: input.target ?? 'original',
      },
      read: () => null,
    });
  }

  /** Deletes a folder a restore set aside ("Delete previous version"). */
  backupDiscard(path: string, actor: RootActor): Promise<BackupOutcome<null>> {
    return this.backup(
      'discard',
      actor,
      'backup.discard',
      { path },
      { audit: { path }, read: () => null },
    );
  }

  /** Deletes all archives of an item that is no longer backed up. */
  backupForget(itemId: string, actor: RootActor): Promise<BackupOutcome<null>> {
    return this.backup(
      'forget',
      actor,
      'backup.forget',
      { itemId },
      {
        audit: { itemId },
        timeoutMs: BACKUP_LONG_TIMEOUT_MS,
        read: () => null,
      },
    );
  }

  backupList(actor: RootActor): Promise<BackupOutcome<{ archives: Record<string, string[]> }>> {
    return this.backup('list', actor, 'backup.list', null, {
      audit: {},
      read: (result) => {
        const archives = result?.['archives'];
        if (typeof archives !== 'object' || archives === null || Array.isArray(archives)) {
          return undefined;
        }
        const valid = Object.values(archives).every(
          (names) => Array.isArray(names) && names.every((name) => typeof name === 'string'),
        );
        return valid ? { archives: archives as Record<string, string[]> } : undefined;
      },
    });
  }

  /** The passphrase reaches the caller only: never the audit details, an output line or a log. */
  backupPassphrase(
    actor: RootActor,
    reason: 'setup' | 'show',
  ): Promise<BackupOutcome<{ passphrase: string }>> {
    return this.backup('passphrase', actor, 'backup.passphrase', null, {
      audit: { reason },
      read: (result) =>
        typeof result?.['passphrase'] === 'string'
          ? { passphrase: result['passphrase'] }
          : undefined,
    });
  }

  /**
   * The newest backup of Ilexarium in a repository, opened with the passphrase. The passphrase
   * goes to the program only: never the audit details or a log.
   */
  backupRecoverCheck(
    input: { repository: string; passphrase: string },
    actor: RootActor,
  ): Promise<BackupOutcome<ProgramRecoverCheck>> {
    return this.backup('recover-check', actor, 'backup.recover_check', input, {
      audit: { repository: input.repository },
      timeoutMs: BACKUP_LONG_TIMEOUT_MS,
      read: (result) => readRecoverCheck(result),
    });
  }

  /**
   * Restoring Ilexarium from a backup: systemd runs it as its own unit (`ilex-recover@<id>`),
   * which stops this app and replaces its database; returns once it's started.
   */
  backupRecoverStart(
    input: { recoveryId: string; repository: string; passphrase: string; archive: string },
    actor: RootActor,
  ): Promise<BackupOutcome<null>> {
    return this.backup('recover-start', actor, 'backup.recover', input, {
      audit: { recoveryId: input.recoveryId, repository: input.repository, archive: input.archive },
      read: () => null,
    });
  }

  /** Mounts a disk at a folder, kept after a restart (the program checks it all again). */
  async diskMount(
    input: { uuid: string; mountPoint: string; owner: { uid: number; gid: number } | null },
    actor: RootActor,
  ): Promise<DiskOutcome<{ mountPoint: string }>> {
    const result = await this.run(DISK, 'mount', input, actor, {
      audit: {
        action: 'disk.mount',
        details: { uuid: input.uuid, mountPoint: input.mountPoint, mine: input.owner !== null },
      },
      timeoutMs: DISK_TIMEOUT_MS,
      read: (r) =>
        typeof r?.['mountPoint'] === 'string' ? { mountPoint: r['mountPoint'] } : undefined,
    });
    return result.ok ? { ok: true, result: result.value } : { ok: false, code: result.code };
  }

  /**
   * Starts an update to `version` as its own unit (ilex-update@<updateId>), which outlives the
   * app: only the version goes in — the program fetches and checks everything itself.
   */
  async updateStart(
    updateId: string,
    version: string,
    actor: RootActor,
  ): Promise<UpdateStartOutcome> {
    const result = await this.run(UPDATE, 'start', { updateId, version }, actor, {
      audit: { action: 'ilex.update', details: { version } },
      timeoutMs: UPDATE_START_TIMEOUT_MS,
      read: (r) => (typeof r?.['to'] === 'string' ? true : undefined),
    });
    return result.ok ? { ok: true } : { ok: false, code: result.code };
  }

  /** Unmounts a disk mounted here, and forgets it. */
  async diskUnmount(mountPoint: string, actor: RootActor): Promise<DiskOutcome<null>> {
    const result = await this.run(DISK, 'unmount', { mountPoint }, actor, {
      audit: { action: 'disk.unmount', details: { mountPoint } },
      timeoutMs: DISK_TIMEOUT_MS,
      read: () => null,
    });
    return result.ok ? { ok: true, result: null } : { ok: false, code: result.code };
  }

  private async backup<T>(
    command: string,
    actor: RootActor,
    action: AuditAction,
    input: unknown,
    options: {
      audit: Record<string, string | number | boolean | undefined>;
      read: (result: Record<string, unknown> | undefined) => T | undefined;
      timeoutMs?: number;
    },
  ): Promise<BackupOutcome<T>> {
    const details = Object.fromEntries(
      Object.entries(options.audit).filter(([, value]) => value !== undefined),
    ) as Record<string, string | number | boolean>;
    const result = await this.run(BACKUP, command, input, actor, {
      audit: { action, details },
      timeoutMs: options.timeoutMs ?? BACKUP_TASK_TIMEOUT_MS,
      read: options.read,
    });
    return result.ok
      ? { ok: true, result: result.value }
      : { ok: false, code: result.code, result: result.value };
  }

  /**
   * Records the request (fail closed), runs the program, records the outcome. sudo's own refusals
   * (locked, not allowed) are thrown as the Linux side's 403s, after the outcome is recorded.
   */
  private async run<Code extends string, T>(
    kind: ProgramKind<Code>,
    command: string,
    input: unknown,
    actor: RootActor,
    options: {
      audit: { action: AuditAction; details: Record<string, string | number | boolean> };
      timeoutMs: number;
      read: (result: Record<string, unknown> | undefined) => T | undefined;
    },
  ): Promise<Result<Code, T>> {
    const entry = {
      action: options.audit.action,
      userId: actor.user.id,
      username: actor.user.username,
      ip: actor.ip,
    };
    try {
      await this.auditService.record({
        ...entry,
        outcome: 'requested',
        details: options.audit.details,
      });
    } catch {
      throw linuxError(FILES_ERROR_CODES.auditUnavailable, 'The audit log is unavailable');
    }
    const stdin = input === null ? '' : JSON.stringify(input);
    let raw: RawRun;
    try {
      raw = this.direct
        ? await this.spawnDirect(kind.name, command, stdin, options.timeoutMs)
        : await this.throughSudo(kind.name, command, stdin, actor.appSessionId, options.timeoutMs);
    } catch (error) {
      const reason =
        (error as { getResponse?: () => { code?: string } }).getResponse?.().code ?? 'failed';
      await this.auditService.tryRecord({
        ...entry,
        outcome: 'failure',
        details: { ...options.audit.details, reason },
      });
      throw error;
    }
    const result = this.outcome(kind, raw, options.read(raw.results.at(-1)));
    await this.auditService.tryRecord({
      ...entry,
      outcome: result.ok ? 'success' : 'failure',
      details: result.ok
        ? options.audit.details
        : { ...options.audit.details, reason: result.code },
    });
    return result;
  }

  private outcome<Code extends string, T>(
    kind: ProgramKind<Code>,
    raw: RawRun,
    value: T | undefined,
  ): Result<Code, T> {
    const fail = (code: Code): Result<Code, T> => ({ ok: false, code, value: value ?? null });
    if (raw.notStarted) return fail(kind.unavailable);
    if (raw.timedOut) return fail(kind.timedOut);
    if (value !== undefined && raw.exitCode === 0) return { ok: true, value };
    if (raw.lastError) {
      // Own keys only: a code like `constructor` must count as unknown, not as Object's own.
      const known = Object.hasOwn(kind.codes, raw.lastError)
        ? kind.codes[raw.lastError]
        : undefined;
      if (!known) {
        this.logger.error(`ilex-${kind.name} refused: ${raw.lastError} (${raw.lastInfo ?? ''})`);
      }
      return fail(known ?? kind.unavailable);
    }
    return fail(kind.failed);
  }

  /** Through the person's helper and their unlocked ilex-root: `<program> <command>`, the input on its stdin. */
  private async throughSudo(
    program: ProgramKind<string>['name'],
    command: string,
    stdin: string,
    appSessionId: string,
    timeoutMs: number,
  ): Promise<RawRun> {
    const answer = await this.linuxSessions.ask(
      appSessionId,
      { action: 'root.run', program, command, input: stdin, timeoutMs },
      { sudo: true, timeoutMs: timeoutMs + ANSWER_MARGIN_MS },
    );
    const raw: RawRun = {
      exitCode: null,
      notStarted: false,
      timedOut: false,
      lastError: null,
      results: [],
      lastInfo: null,
    };
    if (!answer.ok) {
      const sudo = SUDO_ERRORS[answer.error];
      if (answer.error === 'timed_out') return { ...raw, timedOut: true };
      if (answer.error === 'ended')
        throw linuxError(FILES_ERROR_CODES.linuxSessionRequired, 'Sign in as a Linux user first');
      if (sudo && answer.error !== 'failed') throw linuxError(sudo, 'sudo refused it');
      return { ...raw, notStarted: true };
    }
    raw.exitCode = typeof answer['code'] === 'number' ? answer['code'] : null;
    const output = typeof answer['output'] === 'string' ? answer['output'] : '';
    for (const line of output.split('\n')) this.read(raw, line);
    return raw;
  }

  /** Development: the repository's program, as the developer — never in production. */
  private spawnDirect(
    program: ProgramKind<string>['name'],
    command: string,
    stdin: string,
    timeoutMs: number,
  ): Promise<RawRun> {
    return new Promise((resolve) => {
      const raw: RawRun = {
        exitCode: null,
        notStarted: false,
        timedOut: false,
        lastError: null,
        results: [],
        lastInfo: null,
      };
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(raw);
      };
      const child = spawn(process.execPath, [PROGRAM_FILES[program], command], {
        env: { PATH, LANG: 'C.UTF-8', ILEX_WRAPPER_CONFIG: this.programConfig.file },
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const timer = setTimeout(() => {
        raw.timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);
      for (const stream of [child.stdout, child.stderr]) {
        const splitter = new LineSplitter();
        stream.on('data', (chunk: Buffer) =>
          splitter.push(chunk).forEach((line) => this.read(raw, line)),
        );
        stream.on('end', () => splitter.end().forEach((line) => this.read(raw, line)));
      }
      child.on('error', (error) => {
        this.logger.error(`Could not start ilex-${program}: ${error.message}`);
        raw.notStarted = true;
        finish();
      });
      child.on('close', (code) => {
        raw.exitCode = code;
        finish();
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(stdin);
    });
  }

  /** One output line: a result is parsed whole; never logged (it may be the passphrase). */
  private read(raw: RawRun, line: string): void {
    let parsed = line.startsWith('@@result ') ? parseWrapperLine(line) : null;
    if (parsed?.type !== 'result') parsed = parseWrapperLine(cleanLine(line));
    if (parsed.type === 'result') raw.results.push(parsed.value);
    else if (parsed.type === 'error') raw.lastError = parsed.code;
    else if (parsed.type === 'output' && line.startsWith('@@info '))
      raw.lastInfo = parsed.text.slice(0, 500);
  }
}
