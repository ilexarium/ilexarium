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

/** Linux sign-in: few tries (sshd counts too). */
export const SIGN_IN_LIMIT = { default: { limit: 5, ttl: 60_000 } };
