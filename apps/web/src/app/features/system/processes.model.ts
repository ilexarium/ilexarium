import type { Process, ProcessSignal } from '@laris/shared';

/** The table's columns that sort, htop's: PID USER PRI NI VIRT RES SHR S CPU% MEM% TIME+ Command. */
export const PROCESS_SORTS = [
  'pid',
  'user',
  'priority',
  'nice',
  'virtual',
  'resident',
  'shared',
  'state',
  'cpu',
  'memory',
  'time',
  'command',
] as const;
export type ProcessSort = (typeof PROCESS_SORTS)[number];

/** Ending a process, as the user asked: the process and how. */
export interface EndRequest {
  process: Process;
  signal: ProcessSignal;
}

/** How the signed-in Linux account may end a process: its own, or through its sudo. */
export type EndAs = 'own' | 'administrator';

/** Who a process belongs to, for "Where it goes": a service, a container, a person or the system. */
export interface ProcessGroupId {
  kind: 'service' | 'container' | 'person' | 'system';
  /** The catalog entry, the container's or person's name; '' for the system. */
  name: string;
}

export interface ProcessGroup extends ProcessGroupId {
  /** Share of the whole machine, 0–100 (the summary's CPU), not per core. */
  cpuPercent: number;
  memoryBytes: number;
  count: number;
}

/** The busy-ness of the machine in words, from its load per core. */
export type LoadLevel = 'calm' | 'busy' | 'overloaded';
