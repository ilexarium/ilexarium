import type { Process } from '@ilex/shared';
import type { LoadLevel, ProcessSort } from '../processes.model';

/** Rows shown at first (the busiest, as sorted): a long list is slow and endless on a phone. */
export const SHOWN_FIRST = 50;

/** "Where it goes": the busiest few. */
export const GROUPS_SHOWN = 3;

const STATE_ORDER: Record<Process['state'], number> = {
  running: 0,
  waiting: 1,
  zombie: 2,
  stopped: 3,
  sleeping: 4,
  idle: 5,
  other: 6,
};

/** Ascending orders; the page turns them around for descending. */
export const SORT_ORDER: Record<ProcessSort, (a: Process, b: Process) => number> = {
  pid: (a, b) => a.pid - b.pid,
  user: (a, b) => (a.user ?? '').localeCompare(b.user ?? '') || a.uid - b.uid,
  priority: (a, b) => a.priority - b.priority,
  nice: (a, b) => a.nice - b.nice,
  virtual: (a, b) => a.virtualBytes - b.virtualBytes,
  resident: (a, b) => a.memoryBytes - b.memoryBytes,
  shared: (a, b) => a.sharedBytes - b.sharedBytes,
  state: (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state],
  cpu: (a, b) => a.cpuPercent - b.cpuPercent || a.memoryBytes - b.memoryBytes,
  memory: (a, b) => a.memoryBytes - b.memoryBytes,
  time: (a, b) => a.cpuSeconds - b.cpuSeconds,
  command: (a, b) => a.name.localeCompare(b.name) || a.pid - b.pid,
};

/** Numbers start with the largest, names from A. */
export const DESCENDING_FIRST: Record<ProcessSort, boolean> = {
  pid: false,
  user: false,
  priority: true,
  nice: true,
  virtual: true,
  resident: true,
  shared: true,
  state: false,
  cpu: true,
  memory: true,
  time: true,
  command: false,
};

/** Load per core from which the machine reads as busy, and as overloaded (more work than cores). */
export const LOAD_LEVELS: { level: LoadLevel; from: number }[] = [
  { level: 'overloaded', from: 1 },
  { level: 'busy', from: 0.7 },
  { level: 'calm', from: 0 },
];

/** Phones sort with a list instead of column headers: the useful few. */
export const PHONE_SORTS: ProcessSort[] = ['cpu', 'memory', 'time', 'command', 'pid'];
