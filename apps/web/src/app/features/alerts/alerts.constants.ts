import type { AlertSeverity } from '@laris/shared';
import type { StatusTone } from '../../shared/status-badge/status-badge.model';

export const SEVERITY_TONES: Record<AlertSeverity, StatusTone> = {
  warning: 'warning',
  critical: 'failed',
};
