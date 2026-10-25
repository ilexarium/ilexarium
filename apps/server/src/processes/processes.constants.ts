import type { ProcessState } from '@laris/shared';

/** Per IP, for ending processes; the list itself comes through the topic. */
export const CHANGE_LIMIT = { default: { limit: 20, ttl: 60_000 } };
/** As administrator: a sudo password each time — few tries, like a sign-in. */
export const ADMINISTRATOR_LIMIT = { default: { limit: 5, ttl: 60_000 } };

/** What `kill` and `sudo` say (in English: the command sets `LC_ALL=C`). */
export const KILL_MESSAGES = {
  notFound: /No such process/i,
  notPermitted: /Operation not permitted/i,
  sudoPasswordWrong: /incorrect password|Sorry, try again|no password was provided/i,
  sudoNotAllowed: /not in the sudoers|not allowed to (?:run|execute)|may not run sudo/i,
};

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
