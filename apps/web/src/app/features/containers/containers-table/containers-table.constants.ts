import type { ContainerHealth, ContainerState } from '@ilex/shared';
import type { StatusTone } from '../../../shared/status-badge/status-badge.model';
import type { DotTone } from '../../../shared/status-dot/status-dot.model';

/** A container's health check, as a status badge (`none`: no badge). */
export const HEALTH_TONES: Record<Exclude<ContainerHealth, 'none'>, StatusTone> = {
  healthy: 'healthy',
  starting: 'info',
  unhealthy: 'failed',
};

/** The state's dot: running and restarting ones pulse. */
export const STATE_DOTS: Record<ContainerState, DotTone> = {
  running: 'live',
  created: 'idle',
  restarting: 'busy',
  paused: 'warn',
  removing: 'idle',
  exited: 'idle',
  dead: 'fail',
};

/** A running container failing its health check: red and still. */
export const UNHEALTHY_DOT: DotTone = 'fail';

/** As on the dashboard's tiles. */
export const TREND_COLORS = { cpu: 'var(--chart-1)', memory: 'var(--chart-5)' };

/** Below this many points, no line yet. */
export const TREND_MIN_POINTS = 2;

/** The CPU line's lowest top, in percent. */
export const CPU_TREND_MIN_TOP = 10;
