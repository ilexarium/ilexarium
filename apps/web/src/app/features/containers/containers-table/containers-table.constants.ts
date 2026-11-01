import type { ContainerHealth, ContainerState } from '@laris/shared';
import type { StatusTone } from '../status-badge/status-badge.model';

/** A container's health check, as a status badge (`none`: no badge). */
export const HEALTH_TONES: Record<Exclude<ContainerHealth, 'none'>, StatusTone> = {
  healthy: 'healthy',
  starting: 'info',
  unhealthy: 'failed',
};

export const STATE_DOTS: Record<ContainerState, string> = {
  running: 'bg-success',
  created: 'bg-muted-foreground',
  restarting: 'bg-warning',
  paused: 'bg-warning',
  removing: 'bg-muted-foreground',
  exited: 'bg-muted-foreground',
  dead: 'bg-destructive',
};
