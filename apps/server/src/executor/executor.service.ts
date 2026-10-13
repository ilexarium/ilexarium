import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'node:child_process';
import { SERVICE_ERROR_CODES, type ServiceErrorCode } from '@homelab/shared';
import { AuditService } from '../audit/audit.service.js';
import type { AuditAction } from '../audit/audit-actions.js';
import type { Env } from '../config/env.schema.js';
import type { ComposeOutcome, ComposeRequest } from './executor.model.js';
import { WrapperConfigService } from './wrapper-config.js';
import {
  type ExecutorMode,
  REPO_WRAPPER,
  type WrapperAction,
  type WrapperCommand,
  wrapperCommand,
} from './wrapper-command.js';
import { cleanLine, LineSplitter, maskSecrets, parseWrapperLine } from './wrapper-output.js';

/** Pulling Immich's images can take long; past this, the wrapper is told to stop. */
export const OPERATION_TIMEOUT_MS = 30 * 60_000;

/** The wrapper's `@@error` codes → ours. Anything unknown is a setup problem, never "success". */
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
    return this.run('up', 'service.deploy', request);
  }

  /** Removes a service's containers (its data stays). Rejects only if the audit log can't be written. */
  composeDown(request: Omit<ComposeRequest, 'values'>): Promise<ComposeOutcome> {
    return this.run('down', 'service.remove', request);
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

  private async run(
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

    const outcome = await this.spawnWrapper(action, request);
    await this.audit.tryRecord({
      ...entry,
      outcome: outcome.ok ? 'success' : 'failure',
      details: outcome.ok ? details : { ...details, reason: outcome.code },
    });
    return outcome;
  }

  private spawnWrapper(action: WrapperAction, request: ComposeRequest): Promise<ComposeOutcome> {
    const { file, args, env } = this.command(action, request.catalogId);
    return new Promise((resolve) => {
      let lastError: { code: string; field: string | null } | null = null;
      let sawMarker = false;
      let timedOut = false;
      let settled = false;
      const finish = (outcome: ComposeOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      };

      const child = spawn(file, args, { env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM'); // sudo passes it on to the wrapper
      }, this.timeoutMs);

      const handle = (raw: string) => {
        const line = maskSecrets(cleanLine(raw), request.secrets);
        const parsed = parseWrapperLine(line);
        if (parsed.type === 'phase') {
          sawMarker = true;
          request.onPhase(parsed.phase);
        } else if (parsed.type === 'error') {
          sawMarker = true;
          lastError = {
            code: parsed.code,
            field: parsed.field && request.fields.includes(parsed.field) ? parsed.field : null,
          };
        } else {
          if (line.startsWith('@@')) sawMarker = true;
          request.onOutput(parsed.text);
        }
      };
      for (const stream of [child.stdout, child.stderr]) {
        const splitter = new LineSplitter();
        stream.on('data', (chunk: Buffer) => splitter.push(chunk).forEach(handle));
        stream.on('end', () => splitter.end().forEach(handle));
      }

      child.on('error', (error) => {
        this.logger.error(`Could not start the deploy wrapper (${file}): ${error.message}`);
        finish({ ok: false, code: SERVICE_ERROR_CODES.executorUnavailable, field: null });
      });
      child.on('close', (code) => {
        if (code === 0) return finish({ ok: true });
        if (timedOut) return finish({ ok: false, code: SERVICE_ERROR_CODES.timedOut, field: null });
        if (lastError) {
          // Own keys only: a code like `constructor` must count as unknown, not as Object's own.
          const known = Object.hasOwn(WRAPPER_CODES, lastError.code)
            ? WRAPPER_CODES[lastError.code]
            : undefined;
          if (!known) this.logger.error(`The deploy wrapper refused: ${lastError.code}`);
          return finish({
            ok: false,
            code: known ?? SERVICE_ERROR_CODES.executorUnavailable,
            field: lastError.field,
          });
        }
        // No marker at all: the wrapper never ran (e.g. sudo refused: no sudoers rule).
        if (!sawMarker) this.logger.error(`The deploy wrapper did not run (exit ${code})`);
        finish({
          ok: false,
          code: sawMarker
            ? SERVICE_ERROR_CODES.composeFailed
            : SERVICE_ERROR_CODES.executorUnavailable,
          field: null,
        });
      });

      child.stdin.on('error', () => undefined); // the wrapper may exit before reading (a refusal)
      child.stdin.end(action === 'up' ? JSON.stringify(request.values ?? {}) : '');
    });
  }
}
