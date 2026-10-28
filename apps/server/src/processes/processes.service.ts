import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  type ApiErrorResponse,
  type FilesErrorCode,
  PROCESS_ERROR_CODES,
  type ProcessErrorCode,
  type ProcessSignalRequest,
} from '@laris/shared';
import { AuditService } from '../audit/audit.service.js';
import { isKernelThread } from '../host/process-parsers.js';
import { SystemReader } from '../host/system-reader.js';
import { linuxError, linuxSessionRequired } from '../linux-sessions/linux-session-errors.js';
import { LinuxSessions } from '../linux-sessions/linux-sessions.js';
import type { LinuxActor } from '../linux-sessions/linux-sessions.model.js';
import { SIGNAL_ERRORS } from './processes.constants.js';

const apiErrorCode = (error: unknown): string | undefined =>
  error instanceof HttpException
    ? (error.getResponse() as Partial<ApiErrorResponse>).code
    : undefined;

/** Never 401: that means the app session is gone (the Linux side's rule). */
const STATUS: Record<ProcessErrorCode, HttpStatus> = {
  [PROCESS_ERROR_CODES.processNotFound]: HttpStatus.NOT_FOUND,
  [PROCESS_ERROR_CODES.processProtected]: HttpStatus.FORBIDDEN,
  [PROCESS_ERROR_CODES.processNotPermitted]: HttpStatus.FORBIDDEN,
  [PROCESS_ERROR_CODES.signalFailed]: HttpStatus.BAD_GATEWAY,
  [PROCESS_ERROR_CODES.timedOut]: HttpStatus.GATEWAY_TIMEOUT,
  [PROCESS_ERROR_CODES.auditUnavailable]: HttpStatus.SERVICE_UNAVAILABLE,
};

function failure(code: ProcessErrorCode | FilesErrorCode): HttpException {
  if (!(code in STATUS))
    return linuxError(code as FilesErrorCode, 'The process could not be ended');
  const body: ApiErrorResponse = { message: 'The process could not be ended', code };
  return new HttpException(body, STATUS[code as ProcessErrorCode]);
}

/**
 * Ending a process (docs/plans/process_list.md) as the signed-in Linux account, through its
 * session's helper — another account's process through the account's unlocked sudo
 * (docs/plans/acting_as_you.md). Linux decides what the account may end; the app only makes sure
 * it's the process the person saw (PID and start time), never PID 1 or a kernel thread, and
 * records it first (no record, no signal).
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
  ): Promise<void> {
    const linux = this.linuxSessions.current(appSessionId);
    if (!linux) throw linuxSessionRequired();
    const raw = await this.systemReader.process(request.pid);
    if (!raw || raw.startTicks !== request.startTicks) {
      throw failure(PROCESS_ERROR_CODES.processNotFound);
    }
    if (raw.pid === 1 || isKernelThread(raw)) throw failure(PROCESS_ERROR_CODES.processProtected);

    // Another account's process: through sudo. An unknown uid tries as the account itself.
    const asAdministrator = linux.uid !== null && raw.uids[0] !== linux.uid;
    // Never the command line (it may hold passwords).
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

    let code: ProcessErrorCode | FilesErrorCode | null;
    try {
      const answer = await this.linuxSessions.ask(
        appSessionId,
        {
          action: 'process.signal',
          pid: raw.pid,
          signal: request.signal,
          administrator: asAdministrator,
        },
        { sudo: asAdministrator },
      );
      code = answer.ok ? null : (SIGNAL_ERRORS[answer.error] ?? PROCESS_ERROR_CODES.signalFailed);
      if (code === PROCESS_ERROR_CODES.signalFailed) {
        this.logger.warn(`Ending process ${raw.pid} failed (${answer.ok ? '' : answer.error})`);
      }
    } catch (error) {
      // The Linux session ended meanwhile, or it has no helper: its own code.
      const reason = apiErrorCode(error) ?? PROCESS_ERROR_CODES.signalFailed;
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
    if (code !== null) throw failure(code);
  }
}
