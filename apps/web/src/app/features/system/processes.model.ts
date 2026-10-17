import type { Process, ProcessSignal } from '@homelab/shared';

export const PROCESS_SORTS = ['cpu', 'memory', 'name', 'pid'] as const;
export type ProcessSort = (typeof PROCESS_SORTS)[number];

/** Ending a process, as the user asked: the process and how. */
export interface EndRequest {
  process: Process;
  signal: ProcessSignal;
}
