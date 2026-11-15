/**
 * Password hashes for anonymous requests running at once. Each takes 128 MiB and a thread of
 * Node's pool of four (which also reads files): sign-ins from anywhere never take it all.
 */
export const ANONYMOUS_HASHES_AT_ONCE = 2;
/** What a sign-in that finds every slot taken is told to wait. */
export const HASHES_BUSY_RETRY_AFTER_SECONDS = 1;
