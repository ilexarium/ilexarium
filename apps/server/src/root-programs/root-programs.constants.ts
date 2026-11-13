import { fileURLToPath } from 'node:url';
import {
  BACKUP_ERROR_CODES,
  type BackupErrorCode,
  DISK_ERROR_CODES,
  type DiskErrorCode,
  UPDATE_ERROR_CODES,
  type UpdateErrorCode,
} from '@ilex/shared';
import type { ProgramKind } from './root-programs.model.js';

/** Deleting an item's archives can take long. */
export const BACKUP_LONG_TIMEOUT_MS = 30 * 60_000;
/** Setting up, changing the plan, starting a run or a restore, the passphrase: quick. */
export const BACKUP_TASK_TIMEOUT_MS = 5 * 60_000;
/** Mounting waits for systemd; a slow USB disk takes seconds. */
export const DISK_TIMEOUT_MS = 2 * 60_000;
/** ilex-update's `start` checks and starts a unit: quick. */
export const UPDATE_START_TIMEOUT_MS = 60_000;
/** The helper's answer comes a little after the program's own limit. */
export const ANSWER_MARGIN_MS = 10_000;

export const PATH = '/usr/sbin:/usr/bin:/sbin:/bin';

const repo = (file: string) =>
  fileURLToPath(new URL(`../../../../system/programs/${file}`, import.meta.url));

/** In this repository: run directly in development (`ROOT_PROGRAMS=direct`), never in production. */
export const PROGRAM_FILES = {
  backup: repo('ilex-backup.mts'),
  disk: repo('ilex-disk.mts'),
  update: repo('ilex-update.mts'),
} as const;

/** ilex-backup's `@@error` codes → ours (most are the same words). */
const BACKUP_CODES: Record<string, BackupErrorCode> = {
  destination_unavailable: BACKUP_ERROR_CODES.destinationUnavailable,
  destination_not_allowed: BACKUP_ERROR_CODES.destinationNotAllowed,
  repository_mismatch: BACKUP_ERROR_CODES.repositoryMismatch,
  repository_exists: BACKUP_ERROR_CODES.repositoryExists,
  passphrase_invalid: BACKUP_ERROR_CODES.passphraseInvalid,
  disk_full: BACKUP_ERROR_CODES.diskFull,
  source_missing: BACKUP_ERROR_CODES.sourceMissing,
  service_not_restarted: BACKUP_ERROR_CODES.serviceNotRestarted,
  service_not_stopped: BACKUP_ERROR_CODES.serviceNotStopped,
  dump_failed: BACKUP_ERROR_CODES.dumpFailed,
  busy: BACKUP_ERROR_CODES.busy,
  repository_damaged: BACKUP_ERROR_CODES.repositoryDamaged,
  borg_failed: BACKUP_ERROR_CODES.borgFailed,
  interrupted: BACKUP_ERROR_CODES.interrupted,
  archive_not_found: BACKUP_ERROR_CODES.archiveNotFound,
  path_not_allowed: BACKUP_ERROR_CODES.pathNotAllowed,
  path_others_can_change: BACKUP_ERROR_CODES.pathOthersCanChange,
  target_not_empty: BACKUP_ERROR_CODES.targetNotEmpty,
  item_not_found: BACKUP_ERROR_CODES.itemNotFound,
  not_configured: BACKUP_ERROR_CODES.notConfigured,
  not_found: BACKUP_ERROR_CODES.restoreNotFound,
  invalid_plan: BACKUP_ERROR_CODES.invalidPlan,
};

/** ilex-disk's `@@error` codes → ours (the same words). */
const DISK_CODES: Record<string, DiskErrorCode> = Object.fromEntries(
  Object.values(DISK_ERROR_CODES).map((code) => [code, code]),
);

export const BACKUP: ProgramKind<BackupErrorCode> = {
  name: 'backup',
  codes: BACKUP_CODES,
  failed: BACKUP_ERROR_CODES.borgFailed,
  unavailable: BACKUP_ERROR_CODES.programUnavailable,
  timedOut: BACKUP_ERROR_CODES.timedOut,
};

/** ilex-update's `start` refusals → ours; anything else is a setup problem. */
const UPDATE_CODES: Record<string, UpdateErrorCode> = {
  not_configured: UPDATE_ERROR_CODES.notConfigured,
  not_newer: UPDATE_ERROR_CODES.notAvailable,
  busy: UPDATE_ERROR_CODES.busy,
};

export const UPDATE: ProgramKind<UpdateErrorCode> = {
  name: 'update',
  codes: UPDATE_CODES,
  failed: UPDATE_ERROR_CODES.unavailable,
  unavailable: UPDATE_ERROR_CODES.unavailable,
  timedOut: UPDATE_ERROR_CODES.unavailable,
};

export const DISK: ProgramKind<DiskErrorCode> = {
  name: 'disk',
  codes: DISK_CODES,
  failed: DISK_ERROR_CODES.mountFailed,
  unavailable: DISK_ERROR_CODES.programUnavailable,
  timedOut: DISK_ERROR_CODES.timedOut,
};
