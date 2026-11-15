/** `WebSocket.OPEN`, without needing the global (tests use a fake socket). */
export const OPEN = 1;

/** Reconnecting: the first try after this long, doubling up to the maximum. */
export const FIRST_RETRY_MS = 1_000;
export const MAX_RETRY_MS = 30_000;

/**
 * A hidden tab unsubscribes only after this long, so switching tabs back and forth sends nothing
 * (the server allows 20 messages in 10 s per socket).
 */
export const HIDDEN_GRACE_MS = 10_000;
/** Refused for too many messages: a fresh socket once the server's window has passed. */
export const RATE_LIMITED_RETRY_MS = 10_000;
