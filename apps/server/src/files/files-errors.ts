import { HttpException } from '@nestjs/common';
import { FILES_ERROR_CODES } from '@ilex/shared';
import { linuxError } from '../linux-sessions/linux-session-errors.js';
import {
  SFTP_CONNECTION_LOST,
  SFTP_NO_CONNECTION,
  SFTP_NO_SUCH_FILE,
  SFTP_PERMISSION_DENIED,
} from './files.constants.js';

/**
 * An SFTP error as ours: not found, permission denied (what Linux refused), the connection gone,
 * or anything else the server refused (a full disk, a folder not empty) — its own text stays in
 * the server's log, not the answer. Errors that are ours already pass through.
 */
export function toFilesError(error: unknown): HttpException {
  if (error instanceof HttpException) return error;
  const code = (error as { code?: unknown }).code;
  switch (code) {
    case SFTP_NO_SUCH_FILE:
      return linuxError(FILES_ERROR_CODES.notFound, 'No such file or folder');
    case SFTP_PERMISSION_DENIED:
      return linuxError(FILES_ERROR_CODES.permissionDenied, 'Linux refused it for this account');
    case SFTP_NO_CONNECTION:
    case SFTP_CONNECTION_LOST:
    case 'ECONNRESET':
    case 'ERR_STREAM_PREMATURE_CLOSE':
      return linuxError(
        FILES_ERROR_CODES.sshUnavailable,
        'The connection to the SSH server was lost',
      );
    default:
      return linuxError(FILES_ERROR_CODES.failed, 'The SSH server refused it');
  }
}

/** The helper's refusal of a folder's deletion, as ours. */
export function removalError(error: string): HttpException {
  switch (error) {
    case 'not_permitted':
      return linuxError(FILES_ERROR_CODES.permissionDenied, 'Linux refused it for this account');
    case 'path_protected':
      return linuxError(FILES_ERROR_CODES.permissionDenied, 'That folder is never deleted');
    case 'ended':
      return linuxError(FILES_ERROR_CODES.linuxSessionRequired, 'Sign in as a Linux user first');
    case 'sudo_required':
      return linuxError(FILES_ERROR_CODES.sudoRequired, 'Unlock sudo first');
    default:
      return linuxError(FILES_ERROR_CODES.failed, 'The folder was not deleted');
  }
}

/** The code of one of our errors (in its response body), or undefined. */
export function filesCode(error: unknown): string | undefined {
  if (!(error instanceof HttpException)) return undefined;
  const body = error.getResponse();
  return typeof body === 'object' ? (body as { code?: string }).code : undefined;
}
