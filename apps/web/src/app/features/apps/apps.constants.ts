import type { AppState, AppTaskState } from '@laris/shared';
import type { StatusTone } from '../../shared/status-badge/status-badge.model';

/** How an app's containers are doing, as a status badge. */
export const APP_STATE_TONES: Record<AppState, StatusTone> = {
  running: 'healthy',
  partial: 'warning',
  unhealthy: 'failed',
  stopped: 'neutral',
  none: 'neutral',
};

export const TASK_STATE_TONES: Record<AppTaskState, StatusTone> = {
  running: 'info',
  succeeded: 'healthy',
  failed: 'failed',
  interrupted: 'warning',
};

/** The name typed is checked this long after the last key. */
export const NAME_CHECK_MS = 300;

/** "Back up this app first" waits this long for its backup at most. */
export const BACKUP_WAIT_MS = 6 * 60 * 60_000;
