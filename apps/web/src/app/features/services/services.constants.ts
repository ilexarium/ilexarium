import type { ServiceStatus } from '@laris/shared';
import type { StatusTone } from '../../shared/status-badge/status-badge.model';
import type { ServiceRuntime } from './services.model';

/** How an installed service's containers are doing, as a status badge. */
export const RUNTIME_TONES: Record<ServiceRuntime, StatusTone> = {
  running: 'healthy',
  partial: 'warning',
  stopped: 'neutral',
  unhealthy: 'failed',
};

/** Where an install stands, as a status badge. */
export const SERVICE_STATUS_TONES: Record<ServiceStatus, StatusTone> = {
  installing: 'info',
  installed: 'neutral',
  failed: 'failed',
  removing: 'info',
  removed: 'neutral',
};
