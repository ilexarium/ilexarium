/** RFC 6455 §7.4.1. */
export const GOING_AWAY = 1001;
export const POLICY_VIOLATION = 1008;
export const INTERNAL_ERROR = 1011;

/** Output waiting for a slow browser: the shell pauses above HIGH, resumes below LOW. */
export const HIGH_WATER = 1024 * 1024;
export const LOW_WATER = 256 * 1024;

export const SESSION_RECHECK_MS = 30_000;

/** The app password is checked: few tries. */
export const TICKET_LIMIT = { default: { limit: 5, ttl: 60_000 } };
