import type { BackupRunStatus, BackupStatus } from '@laris/shared';
import type { DotTone } from '../../shared/status-dot/status-dot.model';

/** An item's last result, as a status dot. */
export const ITEM_STATUS_DOTS: Record<BackupStatus, DotTone> = {
  ok: 'ok',
  warning: 'warn',
  failed: 'fail',
};

/** A backup run's result, as a status dot: pulsing while it runs. */
export const RUN_STATUS_DOTS: Record<BackupRunStatus, DotTone> = {
  running: 'busy',
  ok: 'ok',
  warning: 'warn',
  failed: 'fail',
};

/** The retention's parts, in the order they're shown. */
export const RETENTION_PARTS = ['daily', 'weekly', 'monthly'] as const;

/** A finished restore stays shown this long (one with folders set aside, until they're deleted). */
export const RESTORE_SHOWN_MS = 24 * 60 * 60_000;

/** The tabs, in the URL's words. */
export const BACKUPS_TABS = ['items', 'history', 'settings'] as const;

/** A disk path longer than this is shown by its last folder (full on hover). */
export const DISK_PATH_SHOWN = 24;
