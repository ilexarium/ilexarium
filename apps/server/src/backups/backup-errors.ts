import { BadRequestException, HttpException, HttpStatus, type Logger } from '@nestjs/common';
import {
  type ApiErrorResponse,
  BACKUP_ERROR_CODES,
  type BackupErrorCode,
  type FieldError,
} from '@laris/shared';
import type { BackupOutcome } from '../executor/executor.model.js';
import { BACKUP_ERROR_STATUS } from './backups.constants.js';

export function apiError(message: string, code: BackupErrorCode): ApiErrorResponse {
  return { message, code };
}

/** A request the friendly checks refused, its problems on their fields. */
export function validationFailed(errors: FieldError[]): BadRequestException {
  return new BadRequestException({
    message: 'Validation failed',
    errors,
  } satisfies ApiErrorResponse);
}

/** A failed backup wrapper call as an HTTP error the web app can word. */
export function backupError(code: BackupErrorCode): HttpException {
  return new HttpException(
    apiError('The backup could not be done', code),
    BACKUP_ERROR_STATUS[code] ?? HttpStatus.INTERNAL_SERVER_ERROR,
  );
}

/** An executor call that must succeed: its result, or the matching HTTP error. */
export async function wrapperCall<T>(
  logger: Logger,
  run: () => Promise<BackupOutcome<T>>,
): Promise<T> {
  const outcome = await wrapperCallRaw(logger, run);
  if (!outcome.ok) throw backupError(outcome.code);
  return outcome.result;
}

/** An executor call; an audit log that couldn't record the request means nothing ran. */
export async function wrapperCallRaw<T>(
  logger: Logger,
  run: () => Promise<BackupOutcome<T>>,
): Promise<BackupOutcome<T>> {
  try {
    return await run();
  } catch (failure) {
    logger.error('Could not record the request in the audit log; nothing ran', failure);
    return { ok: false, code: BACKUP_ERROR_CODES.auditUnavailable, result: null };
  }
}
