/** What laris-update downloads at most (its own ARCHIVE_MAX_BYTES; compared in rules-match-app). */
export const ARCHIVE_MAX_BYTES = 1024 * 1024 * 1024;
export const MANIFEST_MAX_BYTES = 4096;
export const NOTES_MAX_BYTES = 64 * 1024;
export const CHECK_TIMEOUT_MS = 30_000;
export const MAX_REDIRECTS = 5;
/** Once a day, the first a few minutes after starting (not in the middle of an update's restart). */
export const CHECK_EVERY_MS = 24 * 60 * 60_000;
export const FIRST_CHECK_AFTER_MS = 5 * 60_000;
/** Job files: a watch on the folder, and a poll as a fallback. */
export const UPDATE_FILES_POLL_MS = 2000;
export const JOB_READ_MS = 200;
/** The installer's last lines shown. */
export const OUTPUT_LINES_KEPT = 40;
/** The installation's own places (laris-update's; development: under the program config's pretend root). */
export const RELEASE_SETTINGS_DIR = '/etc/laris';
export const UPDATES_DIR = '/var/lib/laris/updates';
/** An update without an end past laris-update's own time limit (its unit's 1 h, and the stop's). */
export const JOB_STALE_MS = 2 * 60 * 60_000;
/** A running update's progress comes line by line: at most one message this often. */
export const UPDATES_PUBLISH_MS = 300;
/** Checking now and changing the switch: a few a minute. */
export const UPDATE_CHANGE_LIMIT = { default: { limit: 10, ttl: 60_000 } };
