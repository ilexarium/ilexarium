import type { SystemService, SystemServiceAction } from '@ilex/shared';
import type { DotTone } from '../../shared/status-dot/status-dot.model';

/** The summary's groups, and the list's order: failed first. */
export type ServiceGroup = 'failed' | 'active' | 'inactive';

/** A service as the list shows it. */
export interface ServiceRow {
  service: SystemService;
  group: ServiceGroup;
  dot: DotTone;
  /** systemd's own words: `active (running)`. */
  state: string;
  /** An action of its runs. */
  pending: boolean;
}

/** What the person chose, for a service. */
export interface ServiceActionRequest {
  name: string;
  action: SystemServiceAction;
}
