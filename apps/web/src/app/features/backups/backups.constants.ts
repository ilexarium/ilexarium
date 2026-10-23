import type { BackupRunStatus } from '@laris/shared';
import type { StatusTone } from '../../shared/status-badge/status-badge.model';

/** A backup run's result, as a status badge. */
export const RUN_STATUS_TONES: Record<BackupRunStatus, StatusTone> = {
  running: 'info',
  ok: 'healthy',
  warning: 'warning',
  failed: 'failed',
};

/** The retention's parts, in the order they're shown. */
export const RETENTION_PARTS = ['daily', 'weekly', 'monthly'] as const;

/** A finished restore stays shown this long (one with folders set aside, until they're deleted). */
export const RESTORE_SHOWN_MS = 24 * 60 * 60_000;
