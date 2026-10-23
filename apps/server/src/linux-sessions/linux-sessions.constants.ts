import { FILES_LIMITS } from '@laris/shared';

/** The machine's own SSH server: never another one. */
export const SSH_HOST = '127.0.0.1';
export const IDLE_MS = FILES_LIMITS.idleMinutes * 60_000;
export const CONNECT_TIMEOUT_MS = 10_000;
/** A connection that stops answering is noticed within a minute. */
export const KEEPALIVE_INTERVAL_MS = 15_000;
export const KEEPALIVE_COUNT_MAX = 3;
/** The server's host keys, in its key folder: `ssh_host_<type>_key.pub`. */
export const HOST_KEY_FILE = /^ssh_host_\w+_key\.pub$/;

/** Linux sign-in: few tries (sshd counts too). */
export const SIGN_IN_LIMIT = { default: { limit: 5, ttl: 60_000 } };
