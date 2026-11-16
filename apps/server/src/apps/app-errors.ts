import { HttpException, HttpStatus } from '@nestjs/common';
import {
  type ApiErrorResponse,
  APP_ERROR_CODES,
  type AppErrorCode,
  FILES_ERROR_CODES,
} from '@ilex/shared';
import { linuxError } from '../linux-sessions/linux-session-errors.js';
import type { HelperAnswer } from '../linux-sessions/linux-sessions.model.js';
import { SUDO_ERRORS } from '../linux-sessions/linux-sessions.constants.js';

const STATUS: Record<AppErrorCode, HttpStatus> = {
  [APP_ERROR_CODES.notFound]: HttpStatus.NOT_FOUND,
  [APP_ERROR_CODES.nameTaken]: HttpStatus.CONFLICT,
  [APP_ERROR_CODES.folderExists]: HttpStatus.CONFLICT,
  [APP_ERROR_CODES.composeInvalid]: HttpStatus.BAD_REQUEST,
  [APP_ERROR_CODES.changedOnDisk]: HttpStatus.CONFLICT,
  [APP_ERROR_CODES.taskRunning]: HttpStatus.CONFLICT,
  [APP_ERROR_CODES.taskNotStarted]: HttpStatus.BAD_GATEWAY,
  [APP_ERROR_CODES.dockerUnavailable]: HttpStatus.SERVICE_UNAVAILABLE,
  [APP_ERROR_CODES.templateNotFound]: HttpStatus.NOT_FOUND,
  [APP_ERROR_CODES.pathProtected]: HttpStatus.FORBIDDEN,
  [APP_ERROR_CODES.folderUnsafe]: HttpStatus.FORBIDDEN,
  [APP_ERROR_CODES.folderMismatch]: HttpStatus.CONFLICT,
  [APP_ERROR_CODES.failed]: HttpStatus.BAD_GATEWAY,
};

/** `detail`: what Compose or Docker said, for the person (never values: those stay in the files). */
export function appError(code: AppErrorCode, message: string, detail?: string): HttpException {
  const body: ApiErrorResponse & { detail?: string } = { message, code, ...(detail && { detail }) };
  return new HttpException(body, STATUS[code]);
}

/** A helper's refusal as an answer: sudo's own as the Linux side's codes, the rest as ours. */
export function helperError(answer: Extract<HelperAnswer, { ok: false }>): HttpException {
  const sudo = SUDO_ERRORS[answer.error];
  if (sudo && answer.error !== 'failed' && answer.error !== 'timed_out') {
    return linuxError(sudo, 'sudo refused it');
  }
  const said = answer.message;
  switch (answer.error) {
    case 'compose_invalid':
      return appError(APP_ERROR_CODES.composeInvalid, 'Compose refused the files', said);
    case 'task_not_started':
      return appError(APP_ERROR_CODES.taskNotStarted, 'The task did not start', said);
    case 'docker_unavailable':
      return appError(APP_ERROR_CODES.dockerUnavailable, 'Docker is not installed');
    case 'folder_unsafe':
      return appError(APP_ERROR_CODES.folderUnsafe, 'Another account can change it', said);
    case 'path_protected':
      return appError(APP_ERROR_CODES.pathProtected, 'That folder is never deleted');
    case 'not_permitted':
    case 'folder_not_writable':
      return linuxError(FILES_ERROR_CODES.permissionDenied, 'Linux refused it for this account');
    case 'ended':
      return linuxError(FILES_ERROR_CODES.linuxSessionRequired, 'Sign in as a Linux user first');
    default:
      return appError(APP_ERROR_CODES.failed, 'It did not work', said);
  }
}
