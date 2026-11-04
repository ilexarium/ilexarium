/**
 * Stop and restart wait for the container's grace period (10 s unless it sets its own), then
 * Docker kills it. Generous, so a slow but normal stop isn't reported as a failure.
 */
export const ACTION_TIMEOUT_MS = 120_000;

/** Removing many images, or a big build cache, takes a while; Docker carries on regardless. */
export const PRUNE_TIMEOUT_MS = 10 * 60_000;
