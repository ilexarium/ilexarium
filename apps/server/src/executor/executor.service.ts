import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'node:child_process';
import {
  BACKUP_ERROR_CODES,
  type BackupErrorCode,
  SERVICE_ERROR_CODES,
  type ServiceErrorCode,
} from '@homelab/shared';
import { AuditService } from '../audit/audit.service.js';
import type { AuditAction } from '../audit/audit-actions.js';
import type { Env } from '../config/env.schema.js';
import type {
  BackupOutcome,
  BackupRestoreInput,
  ComposeOutcome,
  ComposeRequest,
  ExecutorActor,
  JobCallbacks,
  WrapperBackupPlan,
} from './executor.model.js';
import { WrapperConfigService } from './wrapper-config.js';
import {
  type BackupWrapperAction,
  backupWrapperCommand,
  type ExecutorMode,
  REPO_BACKUP_WRAPPER,
  REPO_WRAPPER,
  type WrapperAction,
  type WrapperCommand,
  wrapperCommand,
} from './wrapper-command.js';
import { cleanLine, LineSplitter, maskSecrets, parseWrapperLine } from './wrapper-output.js';

/** Pulling Immich's images can take long; past this, the wrapper is told to stop. */
export const OPERATION_TIMEOUT_MS = 30 * 60_000;
/** A first backup of a big photo library takes hours; a restore of one too. */
export const BACKUP_TIMEOUT_MS = 24 * 60 * 60_000;
/** Setting up, changing the plan, reading the passphrase: quick. */
const BACKUP_TASK_TIMEOUT_MS = 5 * 60_000;

/** The deploy wrapper's `@@error` codes → ours. Anything unknown is a setup problem, never "success". */
const WRAPPER_CODES: Record<string, ServiceErrorCode> = {
  invalid_values: SERVICE_ERROR_CODES.invalidValues,
  port_in_use: SERVICE_ERROR_CODES.portInUse,
  port_reserved: SERVICE_ERROR_CODES.portReserved,
  path_not_allowed: SERVICE_ERROR_CODES.pathNotAllowed,
  path_not_found: SERVICE_ERROR_CODES.pathNotFound,
  policy_violation: SERVICE_ERROR_CODES.policyViolation,
  compose_failed: SERVICE_ERROR_CODES.composeFailed,
  busy: SERVICE_ERROR_CODES.busy,
  unknown_entry: SERVICE_ERROR_CODES.catalogEntryNotFound,
};

/** The backup wrapper's `@@error` codes → ours (most are the same words). */
const BACKUP_WRAPPER_CODES: Record<string, BackupErrorCode> = {
  destination_unavailable: BACKUP_ERROR_CODES.destinationUnavailable,
  destination_not_allowed: BACKUP_ERROR_CODES.destinationNotAllowed,
  repository_mismatch: BACKUP_ERROR_CODES.repositoryMismatch,
  repository_exists: BACKUP_ERROR_CODES.repositoryExists,
  passphrase_invalid: BACKUP_ERROR_CODES.passphraseInvalid,
  disk_full: BACKUP_ERROR_CODES.diskFull,
  source_missing: BACKUP_ERROR_CODES.sourceMissing,
  service_not_restarted: BACKUP_ERROR_CODES.serviceNotRestarted,
  service_not_stopped: BACKUP_ERROR_CODES.serviceNotStopped,
  dump_failed: BACKUP_ERROR_CODES.dumpFailed,
  busy: BACKUP_ERROR_CODES.busy,
  repository_damaged: BACKUP_ERROR_CODES.repositoryDamaged,
  borg_failed: BACKUP_ERROR_CODES.borgFailed,
  interrupted: BACKUP_ERROR_CODES.interrupted,
  archive_not_found: BACKUP_ERROR_CODES.archiveNotFound,
  path_not_allowed: BACKUP_ERROR_CODES.pathNotAllowed,
  paths_changed: BACKUP_ERROR_CODES.pathsChanged,
  item_not_found: BACKUP_ERROR_CODES.itemNotFound,
  not_configured: BACKUP_ERROR_CODES.notConfigured,
  not_found: BACKUP_ERROR_CODES.restoreNotFound,
  invalid_plan: BACKUP_ERROR_CODES.invalidPlan,
};

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

/**
 * The only way into privileged territory (docs/plans/service_deploys.md, decision 4), and the
 * only code that starts a program (lint-enforced). One typed method per wrapper call. Each
 * records the request in the audit log **first** — if that fails, nothing runs — then runs the
 * wrapper (values on stdin), reports its phases and output (cleaned, secrets masked), and records
 * the outcome. Never throws for a failed operation: it returns a typed outcome.
 */
@Injectable()
export class ExecutorService {
  private readonly logger = new Logger(ExecutorService.name);
  private readonly mode: ExecutorMode;

  constructor(
    config: ConfigService<Env, true>,
    private readonly audit: AuditService,
    private readonly wrapperConfig: WrapperConfigService,
  ) {
    this.mode = config.get('EXECUTOR_MODE', { infer: true });
  }

  /** Deploys a catalog entry with its values. Rejects only if the audit log can't be written. */
  composeUp(request: ComposeRequest): Promise<ComposeOutcome> {
    return this.runCompose('up', 'service.deploy', request);
  }

  /** Removes a service's containers (its data stays). Rejects only if the audit log can't be written. */
  composeDown(request: Omit<ComposeRequest, 'values'>): Promise<ComposeOutcome> {
    return this.runCompose('down', 'service.remove', request);
  }

  // Backups. Each rejects only if the audit log can't record the request (then nothing ran).

  /** Writes the plan for the timer (the wrapper checks it all again). */
  backupConfigure(plan: WrapperBackupPlan, actor: ExecutorActor): Promise<BackupOutcome<null>> {
    return this.runBackup('configure', 'backup.configure', actor, plan, {
      audit: { destination: plan.destination, items: plan.items.length },
      read: () => null,
    });
  }

  /** Creates the repository (and the passphrase, the first time) on the chosen disk. */
  backupInit(
    destination: string,
    actor: ExecutorActor,
  ): Promise<BackupOutcome<{ repositoryId: string; created: boolean }>> {
    return this.runBackup(
      'init',
      'backup.init',
      actor,
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
   * "Back up now": runs until the run is done (hours, for a first backup). The wrapper writes its
   * progress and results to its files; the outcome only says whether it ran.
   */
  backupRun(
    input: { runId: string; itemId?: string },
    actor: ExecutorActor,
  ): Promise<BackupOutcome<{ status: string; errorCode: string | null }>> {
    return this.runBackup('run', 'backup.run', actor, input, {
      audit: { ...input },
      timeoutMs: BACKUP_TIMEOUT_MS,
      // A run that happened (some items may have failed) prints its summary.
      read: (result) =>
        typeof result?.['status'] === 'string'
          ? {
              status: result['status'],
              errorCode: typeof result['errorCode'] === 'string' ? result['errorCode'] : null,
            }
          : undefined,
      resultMeansRan: true,
    });
  }

  /** Restores an archive in place or to a new folder — a job, with phases and output. */
  backupRestore(
    input: BackupRestoreInput,
    actor: ExecutorActor,
    callbacks: JobCallbacks,
  ): Promise<BackupOutcome<{ targetPath: string | null; setAside: string[] }>> {
    return this.runBackup('restore', 'backup.restore', actor, input, {
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
    return this.runBackup(
      'discard',
      'backup.discard',
      actor,
      { path },
      {
        audit: { path },
        read: () => null,
      },
    );
  }

  /** Deletes all archives of an item that is no longer backed up. */
  backupForget(itemId: string, actor: ExecutorActor): Promise<BackupOutcome<null>> {
    return this.runBackup(
      'forget',
      'backup.forget',
      actor,
      { itemId },
      {
        audit: { itemId },
        timeoutMs: BACKUP_TIMEOUT_MS,
        read: () => null,
      },
    );
  }

  /**
   * Reads the backup passphrase back ("Show again", and once at setup). It reaches the caller
   * only: never the output callbacks, the audit details or a log.
   */
  backupPassphrase(
    actor: ExecutorActor,
    reason: 'setup' | 'show',
  ): Promise<BackupOutcome<{ passphrase: string }>> {
    return this.runBackup('passphrase', 'backup.passphrase', actor, null, {
      audit: { reason },
      read: (result) =>
        typeof result?.['passphrase'] === 'string'
          ? { passphrase: result['passphrase'] }
          : undefined,
    });
  }

  /** How long one operation may take before the wrapper is told to stop; tests shorten it. */
  protected timeoutMs = OPERATION_TIMEOUT_MS;

  /** The command for one call; tests replace the wrapper. */
  protected command(action: WrapperAction, catalogId: string): WrapperCommand {
    return wrapperCommand(this.mode, action, catalogId, {
      wrapper: REPO_WRAPPER,
      configFile: this.wrapperConfig.file,
    });
  }

  /** The backup wrapper's command for one call; tests replace the wrapper. */
  protected backupCommand(action: BackupWrapperAction): WrapperCommand {
    return backupWrapperCommand(this.mode, action, {
      wrapper: REPO_BACKUP_WRAPPER,
      configFile: this.wrapperConfig.file,
    });
  }

  private async runCompose(
    action: WrapperAction,
    auditAction: AuditAction,
    request: ComposeRequest,
  ): Promise<ComposeOutcome> {
    const entry = {
      action: auditAction,
      userId: request.actor.user.id,
      username: request.actor.user.username,
      ip: request.actor.ip,
    };
    const details = {
      catalogId: request.catalogId,
      serviceId: request.serviceId,
      ...request.audit,
    };
    // Fail closed: no record, no action.
    await this.audit.record({ ...entry, outcome: 'requested', details });

    const raw = await this.spawnRaw(this.command(action, request.catalogId), 'deploy', {
      stdin: action === 'up' ? JSON.stringify(request.values ?? {}) : '',
      timeoutMs: this.timeoutMs,
      secrets: request.secrets,
      onPhase: request.onPhase,
      onOutput: request.onOutput,
    });
    const outcome = this.composeOutcome(raw, request.fields);
    await this.audit.tryRecord({
      ...entry,
      outcome: outcome.ok ? 'success' : 'failure',
      details: outcome.ok ? details : { ...details, reason: outcome.code },
    });
    return outcome;
  }

  private composeOutcome(raw: RawRun, fields: readonly string[]): ComposeOutcome {
    if (raw.notStarted)
      return { ok: false, code: SERVICE_ERROR_CODES.executorUnavailable, field: null };
    if (raw.exitCode === 0) return { ok: true };
    if (raw.timedOut) return { ok: false, code: SERVICE_ERROR_CODES.timedOut, field: null };
    if (raw.lastError) {
      // Own keys only: a code like `constructor` must count as unknown, not as Object's own.
      const known = Object.hasOwn(WRAPPER_CODES, raw.lastError.code)
        ? WRAPPER_CODES[raw.lastError.code]
        : undefined;
      if (!known) this.logger.error(`The deploy wrapper refused: ${raw.lastError.code}`);
      const field =
        raw.lastError.field && fields.includes(raw.lastError.field) ? raw.lastError.field : null;
      return { ok: false, code: known ?? SERVICE_ERROR_CODES.executorUnavailable, field };
    }
    // No marker at all: the wrapper never ran (e.g. sudo refused: no sudoers rule).
    if (!raw.sawMarker) this.logger.error(`The deploy wrapper did not run (exit ${raw.exitCode})`);
    return {
      ok: false,
      code: raw.sawMarker
        ? SERVICE_ERROR_CODES.composeFailed
        : SERVICE_ERROR_CODES.executorUnavailable,
      field: null,
    };
  }

  private async runBackup<T>(
    action: BackupWrapperAction,
    auditAction: AuditAction,
    actor: ExecutorActor,
    input: unknown,
    options: {
      audit: Record<string, string | number | boolean | undefined>;
      read: (result: Record<string, unknown> | undefined) => T | undefined;
      timeoutMs?: number;
      callbacks?: JobCallbacks;
      /** A printed result means the operation ran, whatever the exit code (a run with failed items). */
      resultMeansRan?: boolean;
    },
  ): Promise<BackupOutcome<T>> {
    const entry = {
      action: auditAction,
      userId: actor.user.id,
      username: actor.user.username,
      ip: actor.ip,
    };
    const details = Object.fromEntries(
      Object.entries(options.audit).filter(([, value]) => value !== undefined),
    ) as Record<string, string | number | boolean>;
    // Fail closed: no record, no action.
    await this.audit.record({ ...entry, outcome: 'requested', details });

    const raw = await this.spawnRaw(this.backupCommand(action), 'backup', {
      stdin: input === null ? '' : JSON.stringify(input),
      timeoutMs: options.timeoutMs ?? BACKUP_TASK_TIMEOUT_MS,
      onPhase: options.callbacks?.onPhase,
      onOutput: options.callbacks?.onOutput,
    });
    // `undefined`: the result it should have printed is missing; `null`: none is expected.
    const value = options.read(raw.results.at(-1));
    const outcome = this.backupOutcome(raw, value, options.resultMeansRan === true);
    await this.audit.tryRecord({
      ...entry,
      outcome: outcome.ok ? 'success' : 'failure',
      details: outcome.ok ? details : { ...details, reason: outcome.code },
    });
    return outcome;
  }

  private backupOutcome<T>(
    raw: RawRun,
    value: T | undefined,
    resultMeansRan: boolean,
  ): BackupOutcome<T> {
    const result = value ?? null;
    const fail = (code: BackupErrorCode): BackupOutcome<T> => ({ ok: false, code, result });
    if (raw.notStarted) return fail(BACKUP_ERROR_CODES.executorUnavailable);
    if (raw.timedOut) return fail(BACKUP_ERROR_CODES.timedOut);
    if (value !== undefined && (raw.exitCode === 0 || (resultMeansRan && value !== null))) {
      return { ok: true, result: value };
    }
    if (raw.lastError) {
      const known = Object.hasOwn(BACKUP_WRAPPER_CODES, raw.lastError.code)
        ? BACKUP_WRAPPER_CODES[raw.lastError.code]
        : undefined;
      // Its reasons hold paths, never the passphrase (only `passphrase`'s result holds that).
      if (!known) {
        this.logger.error(
          `The backup wrapper refused: ${raw.lastError.code} (${raw.lastInfo ?? ''})`,
        );
      }
      return fail(known ?? BACKUP_ERROR_CODES.executorUnavailable);
    }
    if (!raw.sawMarker) this.logger.error(`The backup wrapper did not run (exit ${raw.exitCode})`);
    return fail(
      raw.sawMarker ? BACKUP_ERROR_CODES.borgFailed : BACKUP_ERROR_CODES.executorUnavailable,
    );
  }

  /** Runs one wrapper call: stdin in, markers and output (cleaned, masked) out. Never rejects. */
  private spawnRaw(
    { file, args, env }: WrapperCommand,
    name: 'deploy' | 'backup',
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
          if (line.startsWith('@@info ')) raw.lastInfo = parsed.text.slice(0, 500);
          options.onOutput?.(maskSecrets(parsed.text, options.secrets ?? []));
        }
      };
      for (const stream of [child.stdout, child.stderr]) {
        const splitter = new LineSplitter();
        stream.on('data', (chunk: Buffer) => splitter.push(chunk).forEach(handle));
        stream.on('end', () => splitter.end().forEach(handle));
      }

      child.on('error', (error) => {
        this.logger.error(`Could not start the ${name} wrapper (${file}): ${error.message}`);
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
