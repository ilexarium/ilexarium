import {
  FILES_ERROR_CODES,
  type FilesErrorCode,
  PROCESS_ERROR_CODES,
  type ProcessErrorCode,
  type ProcessState,
} from '@ilex/shared';

type ApiCode = ProcessErrorCode | FilesErrorCode;

/** Per IP, for ending processes; the list itself comes through the topic. */
export const CHANGE_LIMIT = { default: { limit: 20, ttl: 60_000 } };
/** The helper's answers to `process.signal`, as the API says them (sudo's: the Linux session's). */
export const SIGNAL_ERRORS: Record<string, ApiCode> = {
  not_found: PROCESS_ERROR_CODES.processNotFound,
  not_permitted: PROCESS_ERROR_CODES.processNotPermitted,
  timed_out: PROCESS_ERROR_CODES.timedOut,
  sudo_required: FILES_ERROR_CODES.sudoRequired,
  sudo_not_allowed: FILES_ERROR_CODES.sudoNotAllowed,
  sudo_unavailable: FILES_ERROR_CODES.sudoNotAllowed,
  ended: FILES_ERROR_CODES.helperUnavailable,
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
