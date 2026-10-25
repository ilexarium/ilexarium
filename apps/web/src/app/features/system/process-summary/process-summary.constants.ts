import type { ProcessGroupId } from '../processes.model';

export const GROUP_ICONS: Record<ProcessGroupId['kind'], string> = {
  service: 'lucidePackage',
  container: 'lucideBox',
  person: 'lucideUser',
  system: 'lucideServer',
};

/** The pressure files, in the order shown. */
export const PRESSURE_RESOURCES = ['cpu', 'memory', 'io'] as const;
