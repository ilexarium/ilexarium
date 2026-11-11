import { HttpException, Injectable, Logger } from '@nestjs/common';
import {
  type ApiErrorResponse,
  type FilesErrorCode,
  SYSTEM_SERVICE_ERROR_CODES,
  systemServiceActionAllowed,
  systemServiceProtection,
  type SystemServiceAction,
  type SystemServiceDetails,
  type SystemServiceErrorCode,
  type SystemServicesResponse,
} from '@ilex/shared';
import { AuditService } from '../audit/audit.service.js';
import { linuxError, linuxSessionRequired } from '../linux-sessions/linux-session-errors.js';
import { LinuxSessions } from '../linux-sessions/linux-sessions.js';
import type { HelperAnswer, LinuxActor } from '../linux-sessions/linux-sessions.model.js';
import {
  ACTION_FAILED_MESSAGES,
  CONTROL_TIMEOUT_MS,
  ERROR_STATUS,
  HELPER_ERRORS,
  helperPropertiesSchema,
  helperUnitsSchema,
  READ_TIMEOUT_MS,
  UNSET_BYTES,
} from './system-services.constants.js';

function failure(code: SystemServiceErrorCode | FilesErrorCode, message: string): HttpException {
  if (!(code in ERROR_STATUS)) return linuxError(code as FilesErrorCode, message);
  const body: ApiErrorResponse = { message, code };
  return new HttpException(body, ERROR_STATUS[code as SystemServiceErrorCode]);
}

const apiErrorCode = (error: unknown): string | undefined =>
  error instanceof HttpException
    ? (error.getResponse() as Partial<ApiErrorResponse>).code
    : undefined;

/** A read the helper refused: systemctl's trouble, or the Linux session's. */
function readFailure(answer: HelperAnswer & { ok: false }): HttpException {
  const code = HELPER_ERRORS[answer.error];
  const unavailable = !code || code === SYSTEM_SERVICE_ERROR_CODES.actionFailed;
  return failure(
    unavailable ? SYSTEM_SERVICE_ERROR_CODES.unavailable : code,
    'systemd could not be asked',
  );
}

const integer = (value: string | undefined) =>
  value !== undefined && /^-?\d{1,15}$/.test(value) ? Number(value) : null;

/** `@<seconds>` (`--timestamp=unix`); empty: never. */
function time(value: string | undefined): string | null {
  const seconds = /^@(\d{1,12})$/.exec(value ?? '')?.[1];
  return seconds ? new Date(Number(seconds) * 1000).toISOString() : null;
}

function bytes(value: string | undefined): number | null {
  if (value === undefined || value === UNSET_BYTES || !/^\d{1,20}$/.test(value)) return null;
  return Number(value);
}

/**
 * The host's systemd services: read as the signed-in Linux
 * account through its helper — systemd lets anyone read them —, changed through the account's
 * unlocked sudo (ilex-root). Ilexarium's own units and those it needs are protected here; changes are
 * recorded first (no record, no change).
 */
@Injectable()
export class SystemServicesService {
  private readonly logger = new Logger(SystemServicesService.name);

  constructor(
    private readonly linuxSessions: LinuxSessions,
    private readonly auditService: AuditService,
  ) {}

  async list(appSessionId: string): Promise<SystemServicesResponse> {
    const answer = await this.linuxSessions.ask(
      appSessionId,
      { action: 'units.list' },
      { timeoutMs: READ_TIMEOUT_MS },
    );
    if (!answer.ok) throw readFailure(answer);
    const parsed = helperUnitsSchema.safeParse(answer);
    if (!parsed.success) {
      throw failure(SYSTEM_SERVICE_ERROR_CODES.unavailable, 'systemd could not be asked');
    }
    return {
      services: parsed.data.units.map(({ unit, ...rest }) => ({
        ...rest,
        name: unit,
        protection: systemServiceProtection([unit]),
      })),
      truncated: parsed.data.truncated,
    };
  }

  async details(appSessionId: string, name: string): Promise<SystemServiceDetails> {
    const answer = await this.linuxSessions.ask(
      appSessionId,
      { action: 'units.show', unit: name },
      { timeoutMs: READ_TIMEOUT_MS },
    );
    if (!answer.ok) throw readFailure(answer);
    const parsed = helperPropertiesSchema.safeParse(answer);
    if (!parsed.success) {
      throw failure(SYSTEM_SERVICE_ERROR_CODES.unavailable, 'systemd could not be asked');
    }
    const p = parsed.data.properties;
    // A unit whose file is gone may still run (a package removed): it can still be stopped.
    const gone = p['LoadState'] === 'not-found' && (p['ActiveState'] ?? 'inactive') === 'inactive';
    if (!p['LoadState'] || gone) {
      throw failure(SYSTEM_SERVICE_ERROR_CODES.notFound, 'No such service');
    }
    const id = p['Id'] || name;
    const names = [id, name, ...(p['Names'] ?? '').split(' ').filter(Boolean)];
    const mainPid = integer(p['MainPID']);
    const restarts = integer(p['NRestarts']);
    return {
      name: id,
      description: p['Description'] ?? '',
      load: p['LoadState'],
      active: p['ActiveState'] ?? '',
      sub: p['SubState'] ?? '',
      enabled: p['UnitFileState'] || null,
      protection: systemServiceProtection(names),
      since: time(p['StateChangeTimestamp']),
      mainPid: mainPid && mainPid > 0 ? mainPid : null,
      memoryBytes: bytes(p['MemoryCurrent']),
      result: p['Result'] ?? '',
      exitStatus: integer(p['ExecMainStatus']),
      restarts: restarts !== null && restarts >= 0 ? restarts : null,
      unitFile: p['FragmentPath'] || null,
    };
  }

  /**
   * Starts, stops or restarts a unit through the account's sudo — its canonical name, checked
   * against the protection by all its names (an alias of `ssh.service` is still it).
   */
  async act(
    appSessionId: string,
    name: string,
    action: SystemServiceAction,
    actor: LinuxActor,
  ): Promise<void> {
    const linux = this.linuxSessions.current(appSessionId);
    if (!linux) throw linuxSessionRequired();
    const unit = await this.details(appSessionId, name);
    if (!systemServiceActionAllowed(unit.protection, action)) {
      throw failure(SYSTEM_SERVICE_ERROR_CODES.protected, 'This service is protected');
    }
    const details = { unit: unit.name, linuxUser: linux.username };
    const entry = {
      action: `system_service.${action}` as const,
      userId: actor.user.id,
      username: actor.user.username,
      ip: actor.ip,
    };
    try {
      await this.auditService.record({ ...entry, outcome: 'requested', details });
    } catch {
      throw failure(SYSTEM_SERVICE_ERROR_CODES.auditUnavailable, 'The audit log is unavailable');
    }

    let code: SystemServiceErrorCode | FilesErrorCode | null;
    try {
      const answer = await this.linuxSessions.ask(
        appSessionId,
        { action: 'units.control', unit: unit.name, command: action },
        { sudo: true, timeoutMs: CONTROL_TIMEOUT_MS },
      );
      code = answer.ok
        ? null
        : (HELPER_ERRORS[answer.error] ?? SYSTEM_SERVICE_ERROR_CODES.actionFailed);
      if (!answer.ok && code === SYSTEM_SERVICE_ERROR_CODES.actionFailed) {
        // systemd's own words, for whoever looks into it: never passed on to the browser.
        this.logger.warn(`${action} ${unit.name} failed: ${answer.message ?? answer.error}`);
      }
    } catch (error) {
      // The Linux session ended meanwhile, or it has no helper: its own code.
      const reason = apiErrorCode(error) ?? SYSTEM_SERVICE_ERROR_CODES.actionFailed;
      await this.auditService.tryRecord({
        ...entry,
        outcome: 'failure',
        details: { ...details, reason },
      });
      throw error;
    }
    await this.auditService.tryRecord({
      ...entry,
      outcome: code === null ? 'success' : 'failure',
      details: code === null ? details : { ...details, reason: code },
    });
    if (code !== null) throw failure(code, ACTION_FAILED_MESSAGES[action]);
  }
}
