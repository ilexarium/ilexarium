import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import {
  type ApiErrorResponse,
  BACKUP_ERROR_CODES,
  type BackupErrorCode,
  type FieldError,
} from '@laris/shared';
import type { BackupOutcome } from '../root-programs/root-programs.model.js';

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
  [BACKUP_ERROR_CODES.targetNotEmpty]: HttpStatus.CONFLICT,
  [BACKUP_ERROR_CODES.setAsideKept]: HttpStatus.CONFLICT,
  [BACKUP_ERROR_CODES.invalidPlan]: HttpStatus.UNPROCESSABLE_ENTITY,
  [BACKUP_ERROR_CODES.destinationUnavailable]: HttpStatus.UNPROCESSABLE_ENTITY,
  [BACKUP_ERROR_CODES.destinationNotAllowed]: HttpStatus.UNPROCESSABLE_ENTITY,
  [BACKUP_ERROR_CODES.repositoryMismatch]: HttpStatus.UNPROCESSABLE_ENTITY,
  [BACKUP_ERROR_CODES.archiveNotFound]: HttpStatus.NOT_FOUND,
  [BACKUP_ERROR_CODES.itemNotFound]: HttpStatus.NOT_FOUND,
  [BACKUP_ERROR_CODES.programUnavailable]: HttpStatus.SERVICE_UNAVAILABLE,
  [BACKUP_ERROR_CODES.auditUnavailable]: HttpStatus.SERVICE_UNAVAILABLE,
};

/** A failed backup program call as an HTTP error the web app can word. */
export function backupError(code: BackupErrorCode): HttpException {
  return new HttpException(
    apiError('The backup could not be done', code),
    BACKUP_ERROR_STATUS[code] ?? HttpStatus.INTERNAL_SERVER_ERROR,
  );
}

/**
 * A root program call that must succeed: its result, or the matching HTTP error. Its own throws
 * (sudo locked, the audit log down, the Linux session gone) pass through: nothing ran.
 */
export async function programCall<T>(run: () => Promise<BackupOutcome<T>>): Promise<T> {
  const outcome = await run();
  if (!outcome.ok) throw backupError(outcome.code);
  return outcome.result;
}
