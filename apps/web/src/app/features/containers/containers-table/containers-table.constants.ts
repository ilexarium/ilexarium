import type { ContainerHealth, ContainerState } from '@laris/shared';
import type { StatusTone } from '../../../shared/status-badge/status-badge.model';

/** A container's health check, as a status badge (`none`: no badge). */
export const HEALTH_TONES: Record<Exclude<ContainerHealth, 'none'>, StatusTone> = {
  healthy: 'healthy',
  starting: 'info',
  unhealthy: 'failed',
};

/** The state's dot, in the dashboard's light colours: running and restarting ones pulse. */
export const STATE_DOTS: Record<ContainerState, string> = {
  running: 'text-light-ok motion-safe:animate-light-pulse',
  created: 'text-muted-foreground',
  restarting: 'text-light-warn motion-safe:animate-light-pulse',
  paused: 'text-light-warn',
  removing: 'text-muted-foreground',
  exited: 'text-muted-foreground',
  dead: 'text-light-fail',
};

/** A running container failing its health check: red and still. */
export const UNHEALTHY_DOT = 'text-light-fail';

/** As on the dashboard's tiles. */
export const TREND_COLORS = { cpu: 'var(--chart-1)', memory: 'var(--chart-5)' };

/** Below this many points, no line yet. */
export const TREND_MIN_POINTS = 2;

/** The CPU line's lowest top, in percent. */
export const CPU_TREND_MIN_TOP = 10;
