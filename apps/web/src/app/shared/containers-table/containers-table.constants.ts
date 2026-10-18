import type { ContainerHealth } from '@homelab/shared';
import type { StatusTone } from '../status-badge/status-badge.model';

/** A container's health check, as a status badge (`none`: no badge). */
export const HEALTH_TONES: Record<Exclude<ContainerHealth, 'none'>, StatusTone> = {
  healthy: 'healthy',
  starting: 'info',
  unhealthy: 'failed',
};
