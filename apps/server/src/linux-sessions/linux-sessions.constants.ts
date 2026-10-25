import { FILES_LIMITS } from '@laris/shared';
import type { LinuxCommand } from './linux-sessions.model.js';

/** The machine's own SSH server: never another one. */
export const SSH_HOST = '127.0.0.1';
export const IDLE_MS = FILES_LIMITS.idleMinutes * 60_000;
export const CONNECT_TIMEOUT_MS = 10_000;
/** A connection that stops answering is noticed within a minute. */
export const KEEPALIVE_INTERVAL_MS = 15_000;
export const KEEPALIVE_COUNT_MAX = 3;
/** The server's host keys, in its key folder: `ssh_host_<type>_key.pub`. */
export const HOST_KEY_FILE = /^ssh_host_\w+_key\.pub$/;

/** A command on the Linux session (ending a process, `id`): quick, or something is stuck. */
export const COMMAND_TIMEOUT_MS = 15_000;
/** What is kept of a command's output: its first lines say what happened. */
export const COMMAND_OUTPUT_MAX = 16 * 1024;
/** The account's uid, asked once at the sign-in (which waits for it at most this long). */
export const UID_TIMEOUT_MS = 3_000;
/** The account's uid, asked once at the sign-in. */
export const UID_COMMAND = 'id -u' as LinuxCommand;

/** Linux sign-in: few tries (sshd counts too). */
export const SIGN_IN_LIMIT = { default: { limit: 5, ttl: 60_000 } };
