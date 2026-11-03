import type { ServiceGroup } from '../system-services.model';

/** The list is asked again this often while the page is open and shown. */
export const REFRESH_MS = 10_000;

export const GROUP_ORDER: Record<ServiceGroup, number> = { failed: 0, active: 1, inactive: 2 };

export const GROUPS: ServiceGroup[] = ['failed', 'active', 'inactive'];
