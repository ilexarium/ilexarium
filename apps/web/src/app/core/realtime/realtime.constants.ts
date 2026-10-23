/** `WebSocket.OPEN`, without needing the global (tests use a fake socket). */
export const OPEN = 1;

/** Reconnecting: the first try after this long, doubling up to the maximum. */
export const FIRST_RETRY_MS = 1_000;
export const MAX_RETRY_MS = 30_000;
