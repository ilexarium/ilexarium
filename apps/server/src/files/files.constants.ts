/** File type bits of a mode (`stat(2)`). */
export const S_IFMT = 0o170000;
export const S_IFDIR = 0o040000;
export const S_IFREG = 0o100000;
export const S_IFLNK = 0o120000;

/** SFTP's status codes (draft-ietf-secsh-filexfer, ssh2's `STATUS_CODE`). */
export const SFTP_NO_SUCH_FILE = 2;
export const SFTP_PERMISSION_DENIED = 3;
export const SFTP_NO_CONNECTION = 6;
export const SFTP_CONNECTION_LOST = 7;

/** Deleting a big folder through the helper (its `rm` stops after 10 minutes). */
export const DELETE_TIMEOUT_MS = 11 * 60_000;

/** An uploaded file's permissions: the owner's to change, readable by others (like umask 022). */
export const NEW_FILE_MODE = 0o644;

/**
 * As root, folders never renamed or moved (deleting them is refused by ilex-root's removal, and
 * moving one away breaks the machine the same way): the helper's NEVER_REMOVED and
 * NEVER_REMOVED_BELOW, compared in system/programs/rules-match-app.spec.ts.
 */
export const ROOT_NEVER_MOVED = [
  '/',
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/home',
  '/lib',
  '/lib32',
  '/lib64',
  '/media',
  '/mnt',
  '/opt',
  '/proc',
  '/root',
  '/run',
  '/sbin',
  '/srv',
  '/sys',
  '/tmp',
  '/usr',
  '/var',
];
export const ROOT_NEVER_MOVED_BELOW = [
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/lib',
  '/lib32',
  '/lib64',
  '/opt/ilex',
  '/proc',
  '/run',
  '/sbin',
  '/sys',
  '/usr',
  '/var/lib/docker',
  '/var/lib/ilex',
];
