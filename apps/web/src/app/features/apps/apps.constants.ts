import type { AppState, AppTaskState } from '@ilex/shared';
import type { StatusTone } from '../../shared/status-badge/status-badge.model';
import type { DotTone } from '../../shared/status-dot/status-dot.model';

/** How an app's containers are doing, as a status badge. */
export const APP_STATE_TONES: Record<AppState, StatusTone> = {
  running: 'healthy',
  partial: 'warning',
  unhealthy: 'failed',
  stopped: 'neutral',
  none: 'neutral',
};

/** An app's state as a dot: pulsing while (some of) it runs. */
export const APP_STATE_DOTS: Record<AppState, DotTone> = {
  running: 'live',
  partial: 'busy',
  unhealthy: 'fail',
  stopped: 'idle',
  none: 'idle',
};

export const TASK_STATE_TONES: Record<AppTaskState, StatusTone> = {
  running: 'info',
  succeeded: 'healthy',
  failed: 'failed',
  interrupted: 'warning',
};

/** The name typed is checked this long after the last key. */
export const NAME_CHECK_MS = 300;

/** From this many templates on, a search box. */
export const TEMPLATE_SEARCH_FROM = 10;

/** The containers' stats come every 2 s (the server's `PUBLISH_INTERVAL_MS`): one step of a line. */
export const STATS_STEP_MS = 2_000;
