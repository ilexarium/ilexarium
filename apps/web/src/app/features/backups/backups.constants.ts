import type { BackupRunStatus } from '@laris/shared';
import type { StatusTone } from '../../shared/status-badge/status-badge.model';

/** A backup run's result, as a status badge. */
export const RUN_STATUS_TONES: Record<BackupRunStatus, StatusTone> = {
  running: 'info',
  ok: 'healthy',
  warning: 'warning',
  failed: 'failed',
};
