import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  type ApiErrorResponse,
  PROCESS_ERROR_CODES,
  type ProcessErrorCode,
  type ProcessSignalRequest,
} from '@laris/shared';
import { AuditService } from '../audit/audit.service.js';
import { isKernelThread } from '../host/process-parsers.js';
import { SystemReader } from '../host/system-reader.js';
import { linuxSessionRequired } from '../linux-sessions/linux-session-errors.js';
import { LinuxSessions } from '../linux-sessions/linux-sessions.js';
import type { LinuxActor, LinuxCommandResult } from '../linux-sessions/linux-sessions.model.js';
import { killCommand } from './kill-command.js';
import { KILL_MESSAGES } from './processes.constants.js';

/** Never 401: that means the app session is gone (the Linux side's rule). */
const STATUS: Record<ProcessErrorCode, HttpStatus> = {
  [PROCESS_ERROR_CODES.processNotFound]: HttpStatus.NOT_FOUND,
  [PROCESS_ERROR_CODES.processProtected]: HttpStatus.FORBIDDEN,
  [PROCESS_ERROR_CODES.processNotPermitted]: HttpStatus.FORBIDDEN,
  [PROCESS_ERROR_CODES.sudoPasswordWrong]: HttpStatus.FORBIDDEN,
  [PROCESS_ERROR_CODES.sudoNotAllowed]: HttpStatus.FORBIDDEN,
  [PROCESS_ERROR_CODES.signalFailed]: HttpStatus.BAD_GATEWAY,
  [PROCESS_ERROR_CODES.timedOut]: HttpStatus.GATEWAY_TIMEOUT,
  [PROCESS_ERROR_CODES.auditUnavailable]: HttpStatus.SERVICE_UNAVAILABLE,
};

function failure(code: ProcessErrorCode): HttpException {
  const body: ApiErrorResponse = { message: 'The process could not be ended', code };
  return new HttpException(body, STATUS[code]);
}

/** What the command's exit and messages mean; null for success. */
function outcomeOf(result: LinuxCommandResult, asAdministrator: boolean): ProcessErrorCode | null {
  if (result.code === 0) return null;
  if (asAdministrator) {
    // `env` found no sudo (127), or sudo refused.
    if (result.code === 127) return PROCESS_ERROR_CODES.sudoNotAllowed;
    if (KILL_MESSAGES.sudoPasswordWrong.test(result.stderr)) {
      return PROCESS_ERROR_CODES.sudoPasswordWrong;
    }
    if (KILL_MESSAGES.sudoNotAllowed.test(result.stderr)) return PROCESS_ERROR_CODES.sudoNotAllowed;
  }
  if (KILL_MESSAGES.notFound.test(result.stderr)) return PROCESS_ERROR_CODES.processNotFound;
  if (KILL_MESSAGES.notPermitted.test(result.stderr)) {
    return PROCESS_ERROR_CODES.processNotPermitted;
  }
  return PROCESS_ERROR_CODES.signalFailed;
}

/**
 * Ending a process (docs/plans/process_list.md) as the signed-in Linux account, over its SSH
 * session — or through its own `sudo`, with its password for this one action. Linux decides what
 * the account may end; the app only makes sure it's the process the person saw (PID and start
 * time), never PID 1 or a kernel thread, and records it first (no record, no signal).
 */
@Injectable()
export class ProcessesService {
  private readonly logger = new Logger(ProcessesService.name);

  constructor(
    private readonly systemReader: SystemReader,
    private readonly linuxSessions: LinuxSessions,
    private readonly auditService: AuditService,
  ) {}

  async signal(
    appSessionId: string,
    request: ProcessSignalRequest,
    actor: LinuxActor,
    sudoPassword?: string,
  ): Promise<void> {
    const linux = this.linuxSessions.current(appSessionId);
    if (!linux) throw linuxSessionRequired();
    const raw = await this.systemReader.process(request.pid);
    if (!raw || raw.startTicks !== request.startTicks) {
      throw failure(PROCESS_ERROR_CODES.processNotFound);
    }
    if (raw.pid === 1 || isKernelThread(raw)) throw failure(PROCESS_ERROR_CODES.processProtected);

    const asAdministrator = sudoPassword !== undefined;
    // Never the command line (it may hold passwords), never the sudo password.
    const details = {
      pid: raw.pid,
      name: raw.name,
      user: (await this.systemReader.users()).get(raw.uids[0]) ?? '',
      signal: request.signal,
      linuxUser: linux.username,
      asAdministrator,
    };
    const entry = {
      action: 'process.end' as const,
      userId: actor.user.id,
      username: actor.user.username,
      ip: actor.ip,
    };
    try {
      await this.auditService.record({ ...entry, outcome: 'requested', details });
    } catch {
      throw failure(PROCESS_ERROR_CODES.auditUnavailable);
    }

    let code: ProcessErrorCode | null;
    try {
      const result = await this.linuxSessions.run(
        appSessionId,
        killCommand(raw.pid, request.signal, asAdministrator),
        asAdministrator ? `${sudoPassword}\n` : '',
      );
      code = outcomeOf(result, asAdministrator);
      if (code === PROCESS_ERROR_CODES.signalFailed) {
        this.logger.warn(`Ending process ${raw.pid} failed (exit ${result.code})`);
      }
    } catch (error) {
      await this.auditService.tryRecord({
        ...entry,
        outcome: 'failure',
        details: { ...details, reason: PROCESS_ERROR_CODES.timedOut },
      });
      throw error;
    }
    await this.auditService.tryRecord({
      ...entry,
      outcome: code === null ? 'success' : 'failure',
      details: code === null ? details : { ...details, reason: code },
    });
    if (code !== null) throw failure(code);
  }
}
