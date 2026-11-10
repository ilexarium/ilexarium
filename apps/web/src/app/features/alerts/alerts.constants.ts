import type { AlertSeverity } from '@ilex/shared';
import type { DotTone } from '../../shared/status-dot/status-dot.model';

/** An open alert's severity as a status dot. */
export const SEVERITY_DOTS: Record<AlertSeverity, DotTone> = {
  warning: 'warn',
  critical: 'fail',
};
