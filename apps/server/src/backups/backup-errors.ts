import { BadRequestException, HttpException, HttpStatus, type Logger } from '@nestjs/common';
import {
  type ApiErrorResponse,
  BACKUP_ERROR_CODES,
  type BackupErrorCode,
  type FieldError,
} from '@laris/shared';
import type { BackupOutcome } from '../executor/executor.model.js';

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

/** The HTTP status of a failed wrapper call, by its code (others: 500). */
const BACKUP_ERROR_STATUS: Partial<Record<BackupErrorCode, HttpStatus>> = {
  [BACKUP_ERROR_CODES.busy]: HttpStatus.CONFLICT,
  [BACKUP_ERROR_CODES.repositoryExists]: HttpStatus.CONFLICT,
  [BACKUP_ERROR_CODES.pathsChanged]: HttpStatus.CONFLICT,
  [BACKUP_ERROR_CODES.setAsideKept]: HttpStatus.CONFLICT,
  [BACKUP_ERROR_CODES.invalidPlan]: HttpStatus.UNPROCESSABLE_ENTITY,
  [BACKUP_ERROR_CODES.destinationUnavailable]: HttpStatus.UNPROCESSABLE_ENTITY,
  [BACKUP_ERROR_CODES.destinationNotAllowed]: HttpStatus.UNPROCESSABLE_ENTITY,
  [BACKUP_ERROR_CODES.repositoryMismatch]: HttpStatus.UNPROCESSABLE_ENTITY,
  [BACKUP_ERROR_CODES.archiveNotFound]: HttpStatus.NOT_FOUND,
  [BACKUP_ERROR_CODES.itemNotFound]: HttpStatus.NOT_FOUND,
  [BACKUP_ERROR_CODES.executorUnavailable]: HttpStatus.SERVICE_UNAVAILABLE,
  [BACKUP_ERROR_CODES.auditUnavailable]: HttpStatus.SERVICE_UNAVAILABLE,
};

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
