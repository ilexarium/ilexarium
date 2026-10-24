import type { Process } from '@laris/shared';
import type { ProcessSort } from '../processes.model';

/** Rows shown at first (the busiest, as sorted): a long list is slow and endless on a phone. */
export const SHOWN_FIRST = 50;

/** How each sort orders the rows. */
export const SORT_ORDER: Record<ProcessSort, (a: Process, b: Process) => number> = {
  cpu: (a, b) => b.cpuPercent - a.cpuPercent || b.memoryBytes - a.memoryBytes,
  memory: (a, b) => b.memoryBytes - a.memoryBytes,
  name: (a, b) => a.name.localeCompare(b.name) || a.pid - b.pid,
  pid: (a, b) => a.pid - b.pid,
};
