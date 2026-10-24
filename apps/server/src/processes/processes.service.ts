import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import {
  type ApiErrorResponse,
  PROCESS_ERROR_CODES,
  type ProcessErrorCode,
  type ProcessSignalRequest,
} from '@laris/shared';
import type { ExecutorActor } from '../executor/executor.model.js';
import { ExecutorService } from '../executor/executor.service.js';
import { WrapperConfigService } from '../executor/wrapper-config.js';
import { SystemReader } from '../host/system-reader.js';
import { endRules, isEndable } from './process-view.js';

const STATUS: Record<ProcessErrorCode, HttpStatus> = {
  [PROCESS_ERROR_CODES.processNotFound]: HttpStatus.NOT_FOUND,
  [PROCESS_ERROR_CODES.processProtected]: HttpStatus.FORBIDDEN,
  [PROCESS_ERROR_CODES.invalidRequest]: HttpStatus.BAD_REQUEST,
  [PROCESS_ERROR_CODES.signalFailed]: HttpStatus.BAD_GATEWAY,
  [PROCESS_ERROR_CODES.timedOut]: HttpStatus.GATEWAY_TIMEOUT,
  [PROCESS_ERROR_CODES.executorUnavailable]: HttpStatus.SERVICE_UNAVAILABLE,
  [PROCESS_ERROR_CODES.auditUnavailable]: HttpStatus.SERVICE_UNAVAILABLE,
};

function failure(code: ProcessErrorCode): HttpException {
  const body: ApiErrorResponse = { message: 'The process could not be ended', code };
  return new HttpException(body, STATUS[code]);
}

/**
 * Ending a process (docs/plans/process_list.md): the friendly checks first — the same process
 * (PID and start time), a person's — then the executor and the process wrapper, which checks it
 * all again and signals it as its owner.
 */
@Injectable()
export class ProcessesService {
  constructor(
    private readonly systemReader: SystemReader,
    private readonly executorService: ExecutorService,
    private readonly wrapperConfigService: WrapperConfigService,
  ) {}

  async signal(request: ProcessSignalRequest, actor: ExecutorActor): Promise<void> {
    const raw = await this.systemReader.process(request.pid);
    if (!raw || raw.startTicks !== request.startTicks) {
      throw failure(PROCESS_ERROR_CODES.processNotFound);
    }
    if (!isEndable(raw, endRules(this.wrapperConfigService.config.process))) {
      throw failure(PROCESS_ERROR_CODES.processProtected);
    }
    const user = (await this.systemReader.users()).get(raw.uids[0]) ?? null;
    let outcome;
    try {
      outcome = await this.executorService.processSignal(request, { name: raw.name, user }, actor);
    } catch {
      // The request couldn't be recorded: nothing was done.
      throw failure(PROCESS_ERROR_CODES.auditUnavailable);
    }
    if (!outcome.ok) throw failure(outcome.code);
  }
}
