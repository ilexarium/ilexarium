import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'node:child_process';
import { AuditService } from '../audit/audit.service.js';
import type { AuditAction } from '../audit/audit-actions.js';
import type { AuditEntry } from '../audit/audit.model.js';
import type { Env } from '../config/env.schema.js';
import {
  BACKUP,
  BACKUP_TASK_TIMEOUT_MS,
  BACKUP_TIMEOUT_MS,
  COMPOSE,
  DISK,
  DISK_TIMEOUT_MS,
  OPERATION_TIMEOUT_MS,
} from './executor.constants.js';
import type {
  BackupOutcome,
  BackupRestoreInput,
  ComposeOutcome,
  ComposeRequest,
  DiskOutcome,
  ExecutorActor,
  JobCallbacks,
  WrapperBackupPlan,
  WrapperKind,
} from './executor.model.js';
import { WrapperConfigService } from './wrapper-config.js';
import {
  type BackupWrapperAction,
  type DiskWrapperAction,
  type ExecutorMode,
  type WrapperAction,
  type WrapperArgs,
  type WrapperCommand,
  wrapperCommand,
} from './wrapper-command.js';
import type { WrapperName } from './wrapper-command.constants.js';
import { cleanLine, LineSplitter, maskSecrets, parseWrapperLine } from './wrapper-output.js';

/** What one wrapper run printed and how it ended, before it means anything. */
interface RawRun {
  exitCode: number | null;
  /** It never started (no such program). */
  notStarted: boolean;
  timedOut: boolean;
  /** Any marker at all: the wrapper ran (sudo didn't refuse). */
  sawMarker: boolean;
  lastError: { code: string; field: string | null } | null;
  /** Its `@@result` objects, in order. */
  results: Record<string, unknown>[];
  /** Its last `@@info` line: why it refused (logged with an unexpected refusal). */
  lastInfo: string | null;
}

interface SpawnOptions {
  stdin: string;
  timeoutMs: number;
  secrets?: readonly string[];
  onPhase?: JobCallbacks['onPhase'];
  onOutput?: JobCallbacks['onOutput'];
}

/** One run, before it is put in the caller's outcome type. */
type Result<Code extends string, T> =
  { ok: true; value: T } | { ok: false; code: Code; field: string | null; value: T | null };

interface RunOptions<T> extends Omit<SpawnOptions, 'onPhase' | 'onOutput'> {
  audit: { action: AuditAction; actor: ExecutorActor; details: AuditEntry['details'] };
  /** The value its last `@@result` must hold: `undefined` if it's missing, `null` if none is expected. */
  read: (result: Record<string, unknown> | undefined) => T | undefined;
  /** The fields an `@@error field=…` may name (others are dropped). */
  fields?: readonly string[];
  callbacks?: JobCallbacks;
}

/**
 * The only way into privileged territory (docs/plans/service_deploys.md, decision 4), and the
 * only code that starts a program (lint-enforced). Every call records the request in the audit
 * log **first** — if that fails, nothing runs, and the call rejects — then runs the wrapper
 * (values on stdin) and records the outcome. A failed operation is a typed outcome, never a throw.
 */
@Injectable()
export class ExecutorService {
  private readonly logger = new Logger(ExecutorService.name);
  private readonly mode: ExecutorMode;

  constructor(
    config: ConfigService<Env, true>,
    private readonly auditService: AuditService,
    private readonly wrapperConfig: WrapperConfigService,
  ) {
    this.mode = config.get('EXECUTOR_MODE', { infer: true });
  }

  composeUp(request: ComposeRequest): Promise<ComposeOutcome> {
    return this.compose('up', 'service.deploy', request);
  }

  /** Its data stays. */
  composeDown(request: Omit<ComposeRequest, 'values'>): Promise<ComposeOutcome> {
    return this.compose('down', 'service.remove', request);
  }

  /** Writes the plan for the timer (the wrapper checks it all again). */
  backupConfigure(plan: WrapperBackupPlan, actor: ExecutorActor): Promise<BackupOutcome<null>> {
    return this.backup('configure', actor, 'backup.configure', plan, {
      audit: { destination: plan.destination, items: plan.items.length },
      read: () => null,
    });
  }

  /** Creates the repository (and the passphrase, the first time) on the chosen disk. */
  backupInit(
    destination: string,
    actor: ExecutorActor,
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

  /**
   * "Back up now": has systemd start the run as its own unit and returns at once — the run isn't
   * the app's child, so it goes on if the app stops. Its progress and result come back through
   * the wrapper's files, like a scheduled run's.
   */
  backupStart(
    input: { runId: string; itemId?: string },
    actor: ExecutorActor,
  ): Promise<BackupOutcome<null>> {
    return this.backup('start', actor, 'backup.run', input, {
      audit: { ...input },
      read: () => null,
    });
  }

  /** In place or to a new folder — a job, with phases and output. */
  backupRestore(
    input: BackupRestoreInput,
    actor: ExecutorActor,
    callbacks: JobCallbacks,
  ): Promise<BackupOutcome<{ targetPath: string | null; setAside: string[] }>> {
    return this.backup('restore', actor, 'backup.restore', input, {
      audit: { ...input },
      timeoutMs: BACKUP_TIMEOUT_MS,
      callbacks,
      read: (result) =>
        result && Array.isArray(result['setAside'])
          ? {
              targetPath: typeof result['targetPath'] === 'string' ? result['targetPath'] : null,
              setAside: result['setAside'].filter((p): p is string => typeof p === 'string'),
            }
          : undefined,
    });
  }

  /** Deletes a folder a restore set aside ("Delete previous version"). */
  backupDiscard(path: string, actor: ExecutorActor): Promise<BackupOutcome<null>> {
    return this.backup(
      'discard',
      actor,
      'backup.discard',
      { path },
      {
        audit: { path },
        read: () => null,
      },
    );
  }

  /** Deletes all archives of an item that is no longer backed up. */
  backupForget(itemId: string, actor: ExecutorActor): Promise<BackupOutcome<null>> {
    return this.backup(
      'forget',
      actor,
      'backup.forget',
      { itemId },
      {
        audit: { itemId },
        timeoutMs: BACKUP_TIMEOUT_MS,
        read: () => null,
      },
    );
  }

  /**
   * "Show again", and once at setup. The passphrase reaches the caller only: never the output
   * callbacks, the audit details or a log.
   */
  backupPassphrase(
    actor: ExecutorActor,
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

  /** At /mnt/<name>, kept after a restart (the wrapper checks it all again). */
  diskMount(
    input: { uuid: string; name: string },
    actor: ExecutorActor,
  ): Promise<DiskOutcome<{ mountPoint: string }>> {
    return this.disk('mount', actor, 'disk.mount', input, (result) =>
      typeof result?.['mountPoint'] === 'string' ? { mountPoint: result['mountPoint'] } : undefined,
    );
  }

  /** Unmounts a disk mounted here, and forgets it. */
  diskUnmount(name: string, actor: ExecutorActor): Promise<DiskOutcome<null>> {
    return this.disk('unmount', actor, 'disk.unmount', { name }, () => null);
  }

  /** How long mounting or unmounting may take; tests shorten it. */
  protected diskTimeoutMs = DISK_TIMEOUT_MS;

  /** How long a deploy or removal may take; tests shorten it. */
  protected timeoutMs = OPERATION_TIMEOUT_MS;

  /** The command for one call; tests replace the wrapper. */
  protected command<W extends WrapperName>(wrapper: W, args: WrapperArgs[W]): WrapperCommand {
    return wrapperCommand(this.mode, wrapper, args, this.wrapperConfig.file);
  }

  private async compose(
    action: WrapperAction,
    auditAction: AuditAction,
    request: ComposeRequest,
  ): Promise<ComposeOutcome> {
    const result = await this.run(COMPOSE, [action, request.catalogId], {
      audit: {
        action: auditAction,
        actor: request.actor,
        details: { catalogId: request.catalogId, serviceId: request.serviceId, ...request.audit },
      },
      stdin: action === 'up' ? JSON.stringify(request.values ?? {}) : '',
      timeoutMs: this.timeoutMs,
      secrets: request.secrets,
      fields: request.fields,
      callbacks: { onPhase: request.onPhase, onOutput: request.onOutput },
      read: () => null,
    });
    return result.ok ? { ok: true } : { ok: false, code: result.code, field: result.field };
  }

  private async backup<T>(
    action: BackupWrapperAction,
    actor: ExecutorActor,
    auditAction: AuditAction,
    input: unknown,
    options: {
      audit: Record<string, string | number | boolean | undefined>;
      read: RunOptions<T>['read'];
      timeoutMs?: number;
      callbacks?: JobCallbacks;
    },
  ): Promise<BackupOutcome<T>> {
    const details = Object.fromEntries(
      Object.entries(options.audit).filter(([, value]) => value !== undefined),
    ) as Record<string, string | number | boolean>;
    const result = await this.run(BACKUP, [action], {
      audit: { action: auditAction, actor, details },
      stdin: input === null ? '' : JSON.stringify(input),
      timeoutMs: options.timeoutMs ?? BACKUP_TASK_TIMEOUT_MS,
      callbacks: options.callbacks,
      read: options.read,
    });
    return result.ok
      ? { ok: true, result: result.value }
      : { ok: false, code: result.code, result: result.value };
  }

  private async disk<T>(
    action: DiskWrapperAction,
    actor: ExecutorActor,
    auditAction: AuditAction,
    input: Record<string, string>,
    read: RunOptions<T>['read'],
  ): Promise<DiskOutcome<T>> {
    const result = await this.run(DISK, [action], {
      audit: { action: auditAction, actor, details: input },
      stdin: JSON.stringify(input),
      timeoutMs: this.diskTimeoutMs,
      read,
    });
    return result.ok ? { ok: true, result: result.value } : { ok: false, code: result.code };
  }

  /** Records the request (fail closed: no record, no run), runs the wrapper, records the outcome. */
  private async run<Code extends string, T, W extends WrapperName>(
    kind: WrapperKind<Code, W>,
    args: WrapperArgs[W],
    { audit, read, fields = [], callbacks, ...spawnOptions }: RunOptions<T>,
  ): Promise<Result<Code, T>> {
    const entry = {
      action: audit.action,
      userId: audit.actor.user.id,
      username: audit.actor.user.username,
      ip: audit.actor.ip,
    };
    await this.auditService.record({ ...entry, outcome: 'requested', details: audit.details });
    const raw = await this.spawnRaw(this.command(kind.name, args), kind.label, {
      ...spawnOptions,
      onPhase: callbacks?.onPhase,
      onOutput: callbacks?.onOutput,
    });
    const result = this.outcome(kind, raw, read(raw.results.at(-1)), fields);
    await this.auditService.tryRecord({
      ...entry,
      outcome: result.ok ? 'success' : 'failure',
      details: result.ok ? audit.details : { ...audit.details, reason: result.code },
    });
    return result;
  }

  private outcome<Code extends string, T>(
    kind: WrapperKind<Code, WrapperName>,
    raw: RawRun,
    value: T | undefined,
    fields: readonly string[],
  ): Result<Code, T> {
    const fail = (code: Code, field: string | null = null): Result<Code, T> => ({
      ok: false,
      code,
      field,
      value: value ?? null,
    });
    if (raw.notStarted) return fail(kind.unavailable);
    if (raw.timedOut) return fail(kind.timedOut);
    if (value !== undefined && raw.exitCode === 0) return { ok: true, value };
    if (raw.lastError) {
      // Own keys only: a code like `constructor` must count as unknown, not as Object's own.
      const known = Object.hasOwn(kind.codes, raw.lastError.code)
        ? kind.codes[raw.lastError.code]
        : undefined;
      if (!known) {
        const reason = kind.logsReason ? ` (${raw.lastInfo ?? ''})` : '';
        this.logger.error(`The ${kind.label} wrapper refused: ${raw.lastError.code}${reason}`);
      }
      const field =
        raw.lastError.field && fields.includes(raw.lastError.field) ? raw.lastError.field : null;
      return fail(known ?? kind.unavailable, field);
    }
    // No marker at all: the wrapper never ran (e.g. sudo refused: no sudoers rule).
    if (!raw.sawMarker) {
      this.logger.error(`The ${kind.label} wrapper did not run (exit ${raw.exitCode})`);
    }
    return fail(raw.sawMarker ? kind.failed : kind.unavailable);
  }

  /** Runs one wrapper call: stdin in, markers and output (cleaned, masked) out. Never rejects. */
  private spawnRaw(
    { file, args, env }: WrapperCommand,
    label: string,
    options: SpawnOptions,
  ): Promise<RawRun> {
    return new Promise((resolve) => {
      const raw: RawRun = {
        exitCode: null,
        notStarted: false,
        timedOut: false,
        sawMarker: false,
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

      const child = spawn(file, args, { env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      const timer = setTimeout(() => {
        raw.timedOut = true;
        child.kill('SIGTERM'); // sudo passes it on to the wrapper
      }, options.timeoutMs);

      const handle = (line: string) => {
        // A result is parsed whole (never shortened like output: cut JSON would be lost).
        let parsed = line.startsWith('@@result ') ? parseWrapperLine(line) : null;
        if (parsed?.type !== 'result') parsed = parseWrapperLine(cleanLine(line));
        if (parsed.type === 'result') {
          // Never output: a result may hold what must not be shown or kept (the passphrase).
          raw.sawMarker = true;
          raw.results.push(parsed.value);
          return;
        }
        if (parsed.type === 'phase') {
          raw.sawMarker = true;
          options.onPhase?.(parsed.phase);
        } else if (parsed.type === 'error') {
          raw.sawMarker = true;
          raw.lastError = { code: parsed.code, field: parsed.field };
        } else {
          if (line.startsWith('@@')) raw.sawMarker = true;
          const text = maskSecrets(parsed.text, options.secrets ?? []);
          if (line.startsWith('@@info ')) raw.lastInfo = text.slice(0, 500);
          options.onOutput?.(text);
        }
      };
      for (const stream of [child.stdout, child.stderr]) {
        const splitter = new LineSplitter();
        stream.on('data', (chunk: Buffer) => splitter.push(chunk).forEach(handle));
        stream.on('end', () => splitter.end().forEach(handle));
      }

      child.on('error', (error) => {
        this.logger.error(`Could not start the ${label} wrapper (${file}): ${error.message}`);
        raw.notStarted = true;
        finish();
      });
      child.on('close', (code) => {
        raw.exitCode = code;
        finish();
      });

      child.stdin.on('error', () => undefined); // the wrapper may exit before reading (a refusal)
      child.stdin.end(options.stdin);
    });
  }
}
