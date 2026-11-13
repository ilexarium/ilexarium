import { ALERT_LIMITS, type AlertSeverity, type BackupWarning } from '@ilex/shared';
import type { AlertMessage } from './alerts.model.js';

export const HOUR_MS = 3_600_000;

/** The containers' rules are looked at this often (time-based: "30 s down", "2 minutes unhealthy"). */
export const CONTAINER_TICK_MS = 10_000;

/** The containers are listed this often (the events stream says the rest at once). */
export const CONTAINER_POLL_MS = 30_000;

/** Disk usage, disks gone missing, the backups' age and disk space: this often. */
export const SLOW_POLL_MS = 60_000;

/** Closed alerts older than they're kept are deleted this often. */
export const PRUNE_MS = HOUR_MS;

/** Backup changes come in bursts: one look at the end. */
export const BACKUP_SETTLE_MS = 1_000;

/** The Docker events the rules use. */
export const HANDLED_ACTIONS = new Set(['die', 'start', 'oom', 'health_status']);

export const BACKUP_CRITICAL = new Set<BackupWarning>([
  'serviceNotRestarted',
  'repositoryDamaged',
  'lastRunFailed',
]);

/** A message not delivered is tried once more after this long. */
export const RETRY_AFTER_MS = 60_000;

/** How often due reminders are looked for. */
export const REMINDER_CHECK_MS = 10 * 60_000;

/** Closed alerts shown on the Alerts page. */
export const CLOSED_SHOWN_DAYS = 7;

export const CLOSED_SHOWN_MAX = 50;

/** An alert whose message never got through is sent again after this long, then at every reminder check until it does. */
export const NEVER_SENT_AFTER_MS = 15 * 60_000;

export const SEVERITY_RANK: Record<AlertSeverity, number> = { warning: 0, critical: 1 };

/** A container that died and didn't come back within this long has stopped (a restart policy brings it back sooner). */
export const DOWN_AFTER_MS = 30_000;

/** A stop or restart from the app: its `die` within this long doesn't count. */
export const EXPECTED_FOR_MS = 60_000;

export const RESTART_WINDOW_MS = ALERT_LIMITS.restartWindowMinutes * 60_000;

export const UNHEALTHY_MS = ALERT_LIMITS.unhealthyMinutes * 60_000;

export const OUT_OF_MEMORY_MS = ALERT_LIMITS.outOfMemoryHours * HOUR_MS;

/** The kinds this watch decides. */
export const CONTAINER_ALERT_KINDS = [
  'serviceDown',
  'restartLoop',
  'unhealthy',
  'outOfMemory',
] as const;

/** No answer within this long: given up. */
export const SEND_TIMEOUT_MS = 10_000;

/** ntfy's priorities: 4 high, 3 default, 2 low. */
export const NTFY_PRIORITY: Record<AlertMessage['severity'], number> = {
  critical: 4,
  warning: 3,
  resolved: 2,
};

export const NTFY_TAGS: Record<AlertMessage['severity'], string> = {
  critical: 'rotating_light',
  warning: 'warning',
  resolved: 'white_check_mark',
};

/** The port of implicit TLS (SMTPS); any other port must offer STARTTLS. */
export const IMPLICIT_TLS_PORT = 465;

/** Per IP, for changes; reads aren't limited. */
export const CHANGE_LIMIT = { default: { limit: 20, ttl: 60_000 } };

/** A test sends a real message: few per minute. */
export const TEST_LIMIT = { default: { limit: 5, ttl: 60_000 } };

/** Changes come in bursts (a disk's alerts, a backup's): at most one update this often. */
export const ALERTS_PUBLISH_MS = 300;

/** Also now and then: closed alerts age out of the list. */
export const ALERTS_REFRESH_MS = 60_000;

export const FULL_FOR_MS = ALERT_LIMITS.diskFullMinutes * 60_000;

export const BACKUP_TITLES: Record<BackupWarning, string> = {
  serviceNotRestarted: "A service wasn't started again after the backup",
  repositoryDamaged: 'The backup repository is damaged',
  lastRunFailed: 'The last backup failed',
  noRecentBackup: 'Nothing has been backed up for more than two days',
  destinationUnavailable: 'The backup disk is not connected',
  lowSpace: 'The backup disk is almost full',
};
