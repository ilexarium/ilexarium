/** Profile changes per IP: plenty for choosing a picture a few times, not for a loop. */
export const CHANGE_LIMIT = { default: { limit: 30, ttl: 60_000 } };

/** The first eight bytes of every PNG. */
export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
