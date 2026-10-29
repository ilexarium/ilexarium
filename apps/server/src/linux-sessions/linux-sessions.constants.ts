import { FILES_ERROR_CODES, FILES_LIMITS, type FilesErrorCode } from '@laris/shared';

/** The machine's own SSH server: never another one. */
export const SSH_HOST = '127.0.0.1';
export const IDLE_MS = FILES_LIMITS.idleMinutes * 60_000;
export const CONNECT_TIMEOUT_MS = 10_000;
/** A connection that stops answering is noticed within a minute. */
export const KEEPALIVE_INTERVAL_MS = 15_000;
export const KEEPALIVE_COUNT_MAX = 3;
/** The server's host keys, in its key folder: `ssh_host_<type>_key.pub`. */
export const HOST_KEY_FILE = /^ssh_host_\w+_key\.pub$/;

/** The helper's first line (`{"laris-helper":1}`): it runs, and listens. */
export const HELPER_READY = 'laris-helper';
/** The sign-in waits this long for it (Node starting on a slow machine). */
export const HELPER_START_TIMEOUT_MS = 10_000;
/** Its answers are short; a longer line means something else is talking. */
export const HELPER_ANSWER_MAX = 64 * 1024;
/** What a program said, passed on with a refusal (Compose's own words). */
export const HELPER_MESSAGE_MAX = 4000;
/** A request it answers at once (who it runs as). */
export const HELPER_QUICK_MS = 5_000;
/** Above the helper's own limits (sudo's delay after a wrong password: 20 s; kill: 10 s). */
export const HELPER_TIMEOUT_MS = 25_000;
/** laris-root's own idle limit: it ends this long after its last action. */
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
