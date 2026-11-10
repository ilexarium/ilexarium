import { HttpException, HttpStatus } from '@nestjs/common';
import { type ApiErrorResponse, FILES_ERROR_CODES, type FilesErrorCode } from '@ilex/shared';

/**
 * Never 401 for the Linux side: in this app a 401 means the *app* session is missing, and the web
 * app signs the person out on it. A refused Linux password or an ended Linux session is a 403,
 * told apart by its code.
 */
const STATUS: Partial<Record<FilesErrorCode, HttpStatus>> = {
  [FILES_ERROR_CODES.linuxSessionRequired]: HttpStatus.FORBIDDEN,
  [FILES_ERROR_CODES.linuxLoginRefused]: HttpStatus.FORBIDDEN,
  [FILES_ERROR_CODES.linuxPasswordLoginsOff]: HttpStatus.FORBIDDEN,
  [FILES_ERROR_CODES.linuxRootRefused]: HttpStatus.FORBIDDEN,
  [FILES_ERROR_CODES.sshUnavailable]: HttpStatus.SERVICE_UNAVAILABLE,
  [FILES_ERROR_CODES.sudoRequired]: HttpStatus.FORBIDDEN,
  [FILES_ERROR_CODES.sudoPasswordWrong]: HttpStatus.FORBIDDEN,
  [FILES_ERROR_CODES.sudoNotAllowed]: HttpStatus.FORBIDDEN,
  [FILES_ERROR_CODES.sudoFailed]: HttpStatus.BAD_GATEWAY,
  [FILES_ERROR_CODES.helperUnavailable]: HttpStatus.SERVICE_UNAVAILABLE,
  [FILES_ERROR_CODES.auditUnavailable]: HttpStatus.SERVICE_UNAVAILABLE,
  [FILES_ERROR_CODES.notFound]: HttpStatus.NOT_FOUND,
  [FILES_ERROR_CODES.permissionDenied]: HttpStatus.FORBIDDEN,
  [FILES_ERROR_CODES.exists]: HttpStatus.CONFLICT,
  [FILES_ERROR_CODES.wrongType]: HttpStatus.CONFLICT,
  [FILES_ERROR_CODES.tooLarge]: HttpStatus.PAYLOAD_TOO_LARGE,
  [FILES_ERROR_CODES.failed]: HttpStatus.CONFLICT,
};

export function linuxError(code: FilesErrorCode, message: string): HttpException {
  const body: ApiErrorResponse = { message, code };
  return new HttpException(body, STATUS[code] ?? HttpStatus.BAD_GATEWAY);
}

export const linuxSessionRequired = () =>
  linuxError(FILES_ERROR_CODES.linuxSessionRequired, 'Sign in as a Linux user first');
