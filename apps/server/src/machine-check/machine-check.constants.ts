/** The later steps' answer after the helper failed. */
export const NOT_CHECKED = { userUnits: null, lingering: null, docker: null } as const;

/** Per IP: each check runs a user unit as the person. */
export const CHECK_LIMIT = { default: { limit: 10, ttl: 60_000 } };
/** Above the helper's own for `docker.access` (a user unit, waited for). */
export const CHECK_TIMEOUT_MS = 35_000;
