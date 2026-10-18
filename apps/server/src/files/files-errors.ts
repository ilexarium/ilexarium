import { HttpException } from '@nestjs/common';
import { FILES_ERROR_CODES } from '@homelab/shared';
import { linuxError } from '../linux-sessions/linux-sessions.js';

/** SFTP's status codes (draft-ietf-secsh-filexfer, ssh2's `STATUS_CODE`). */
const NO_SUCH_FILE = 2;
const PERMISSION_DENIED = 3;
const NO_CONNECTION = 6;
const CONNECTION_LOST = 7;

/**
 * An SFTP error as ours: not found, permission denied (what Linux refused), the connection gone,
 * or anything else the server refused (a full disk, a folder not empty) — its own text stays in
 * the server's log, not the answer. Errors that are ours already pass through.
 */
export function toFilesError(error: unknown): HttpException {
  if (error instanceof HttpException) return error;
  const code = (error as { code?: unknown }).code;
  switch (code) {
    case NO_SUCH_FILE:
      return linuxError(FILES_ERROR_CODES.notFound, 'No such file or folder');
    case PERMISSION_DENIED:
      return linuxError(FILES_ERROR_CODES.permissionDenied, 'Linux refused it for this account');
    case NO_CONNECTION:
    case CONNECTION_LOST:
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

/** The code of one of our errors (in its response body), or undefined. */
export function filesCode(error: unknown): string | undefined {
  if (!(error instanceof HttpException)) return undefined;
  const body = error.getResponse();
  return typeof body === 'object' ? (body as { code?: string }).code : undefined;
}
