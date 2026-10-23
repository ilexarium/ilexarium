/** Per IP, for changes (slow, privileged, rare); reads aren't limited. */
export const CHANGE_LIMIT = { default: { limit: 20, ttl: 60_000 } };

/** Asking for the passphrase: the password is checked, so few tries. */
export const PASSPHRASE_LIMIT = { default: { limit: 5, ttl: 60_000 } };

/** The production places of the wrapper's files (development: under the config's dev folder). */
export const STATE_DIR = '/var/lib/laris/backups';
export const MOUNT_INFO = '/proc/self/mountinfo';

/** The time at the end of an archive's name: `YYYY-MM-DDTHH:MM:SS`, UTC. */
export const ARCHIVE_TIME_LENGTH = 19;

/** Results looked at per item for "last backed up" (a day's runs every 6 hours, and then some). */
export const RESULTS_PER_ITEM = 30;

/** The wrapper checks the plan (recipes, folders) and writes two files: seconds at most. */
export const PLAN_CHANGE_TIMEOUT_MS = 60_000;

export const RUNS_SHOWN = 50;

/** Runs kept in the history; older ones (and their item results) go. */
export const RUNS_KEPT = 500;

/**
 * "Back up now" keeps the one-operation slot until its run shows in the progress file (or has a
 * result): then the follower holds it, like for a scheduled run. Seconds, normally.
 */
export const HANDOVER_MS = 30_000;

/**
 * A "Back up now" run that hasn't shown up by then never started (systemd couldn't run the
 * wrapper): recorded as failed. A run that started shows within seconds — it doesn't wait.
 */
export const START_GRACE_MS = 2 * 60_000;

export const RESTORES_KEPT = 50;
export const RESTORES_SHOWN = 20;

/** Less free space than this share of the disk: a warning. */
export const LOW_SPACE_SHARE = 0.1;

/** Longer than the timer's own limit (24 hours): not running, whatever its pid says. */
export const MAX_RUN_MS = 25 * 60 * 60_000;

/** How often the files are looked at when no change notice arrives (fs.watch can miss some). */
export const BACKUP_FILES_POLL_MS = 5_000;
export const MAX_RESULTS_BYTES = 16 * 1024 * 1024;
/** current.jsonl read at most this much at a time; the rest next time. */
export const MAX_PROGRESS_READ_BYTES = 2 * 1024 * 1024;

/** Changes come in bursts (progress lines, restore output): at most one update this often. */
export const BACKUPS_PUBLISH_MS = 500;
/** Also now and then without a change: "last backed up" ages, the disk fills. */
export const BACKUPS_REFRESH_MS = 60_000;
