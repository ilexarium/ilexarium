import { FILES_ERROR_CODES, FILES_LIMITS, type FilesErrorCode } from '@ilex/shared';

/** The machine's own SSH server: never another one. */
export const SSH_HOST = '127.0.0.1';
export const IDLE_MS = FILES_LIMITS.idleMinutes * 60_000;
export const CONNECT_TIMEOUT_MS = 10_000;
/** A connection that stops answering is noticed within a minute. */
export const KEEPALIVE_INTERVAL_MS = 15_000;
export const KEEPALIVE_COUNT_MAX = 3;
/** The server's host keys, in its key folder: `ssh_host_<type>_key.pub`. */
export const HOST_KEY_FILE = /^ssh_host_\w+_key\.pub$/;

/** The helper's first line (`{"ilex-helper":1}`): it runs, and listens. */
export const HELPER_READY = 'ilex-helper';
/** The sign-in waits this long for it (Node starting on a slow machine). */
export const HELPER_START_TIMEOUT_MS = 10_000;
/** Its longest answer is a root program's output (the helper's ROOT_ANSWER_MAX, the same). */
export const HELPER_ANSWER_MAX = 256 * 1024;
/** What a program said, passed on with a refusal (Compose's own words). */
export const HELPER_MESSAGE_MAX = 4000;
/** A request it answers at once (who it runs as). */
export const HELPER_QUICK_MS = 5_000;
/** Above the helper's own limits (sudo's delay after a wrong password: 20 s; kill: 10 s). */
export const HELPER_TIMEOUT_MS = 25_000;
/** ilex-root's own idle limit: it ends this long after its last action. */
export const SUDO_IDLE_MS = FILES_LIMITS.sudoIdleMinutes * 60_000;
/** The helper's sudo answers, as the API says them. */
export const SUDO_ERRORS: Partial<Record<string, FilesErrorCode>> = {
  wrong_password: FILES_ERROR_CODES.sudoPasswordWrong,
  sudo_required: FILES_ERROR_CODES.sudoRequired,
  sudo_not_allowed: FILES_ERROR_CODES.sudoNotAllowed,
  sudo_unavailable: FILES_ERROR_CODES.sudoNotAllowed,
  // The helper gave up on sudo, or couldn't say what it answered.
  timed_out: FILES_ERROR_CODES.sudoFailed,
  failed: FILES_ERROR_CODES.sudoFailed,
};

/** Linux sign-in: few tries (sshd counts too). */
export const SIGN_IN_LIMIT = { default: { limit: 5, ttl: 60_000 } };
/** Unlocking sudo: a password too, few tries (PAM counts too). */
export const SUDO_LIMIT = { default: { limit: 5, ttl: 60_000 } };

/** OpenSSH's own SFTP server (Debian, Ubuntu): Files as administrator runs it as root. */
export const SFTP_SERVER = '/usr/lib/openssh/sftp-server';
/**
 * The two fixed command lines that start it through the account's sudo — nothing in them comes
 * from a request. `-n` first (an account whose sudo needs no password: it starts at once), then
 * `-S` with the password as the one line sudo reads; `-k`: sudo's own cache is never used, so the
 * password is never taken for SFTP data. LC_ALL=C: sudo's messages in English, for the patterns.
 */
export const ROOT_SFTP_COMMANDS = {
  withoutPassword: `/usr/bin/env LC_ALL=C /usr/bin/sudo -n -k -- ${SFTP_SERVER}`,
  withPassword: `/usr/bin/env LC_ALL=C /usr/bin/sudo -k -S -p '' -- ${SFTP_SERVER}`,
} as const;
/** Above sudo's delay after a wrong password. */
export const ROOT_SFTP_TIMEOUT_MS = 20_000;
/** What sudo and sudo-rs say (LC_ALL=C), as the helper reads them. */
export const ROOT_SFTP_MESSAGES = {
  passwordRequired: /a password is required|interaction required|interactive authentication/i,
  wrongPassword:
    /incorrect password|Sorry, try again|incorrect authentication|authentication failed(?!: interaction required)/i,
  notAllowed:
    /not in the sudoers|not allowed to (?:run|execute)|may not run sudo|I'm afraid I can't do that|command not found|No such file/i,
};
/** Root's SFTP use restarts ilex-root's idle time at most this often (each use counts on our side). */
export const ROOT_TOUCH_EVERY_MS = 60_000;
