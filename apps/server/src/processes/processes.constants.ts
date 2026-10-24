import type { ProcessState } from '@laris/shared';

/** Per IP, for ending processes (privileged); the list itself comes through the topic. */
export const CHANGE_LIMIT = { default: { limit: 20, ttl: 60_000 } };

/** Linux reports times in /proc in USER_HZ ticks: 100 a second on every architecture. */
export const TICKS_PER_SECOND = 100;

export const STATES: Record<string, ProcessState> = {
  R: 'running',
  S: 'sleeping',
  D: 'waiting',
  Z: 'zombie',
  T: 'stopped',
  t: 'stopped',
  I: 'idle',
};

export const PROCESSES_INTERVAL_MS = 2_000;
/** Containers' names and the accounts are looked up again this often (they rarely change). */
export const NAMES_MS = 10_000;
