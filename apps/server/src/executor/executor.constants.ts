import {
  BACKUP_ERROR_CODES,
  type BackupErrorCode,
  DISK_ERROR_CODES,
  type DiskErrorCode,
  SERVICE_ERROR_CODES,
  type ServiceErrorCode,
} from '@laris/shared';
import type { WrapperKind } from './executor.model.js';

/** Pulling Immich's images can take long; past this, the wrapper is told to stop. */
export const OPERATION_TIMEOUT_MS = 30 * 60_000;
/** A restore of a big photo library takes hours; deleting its archives can take long too. */
export const BACKUP_TIMEOUT_MS = 24 * 60 * 60_000;
/** Setting up, changing the plan, reading the passphrase: quick. */
export const BACKUP_TASK_TIMEOUT_MS = 5 * 60_000;

/** The deploy wrapper's `@@error` codes → ours. Anything unknown is a setup problem, never "success". */
const COMPOSE_CODES: Record<string, ServiceErrorCode> = {
  invalid_values: SERVICE_ERROR_CODES.invalidValues,
  port_in_use: SERVICE_ERROR_CODES.portInUse,
  port_reserved: SERVICE_ERROR_CODES.portReserved,
  path_not_allowed: SERVICE_ERROR_CODES.pathNotAllowed,
  path_not_found: SERVICE_ERROR_CODES.pathNotFound,
  policy_violation: SERVICE_ERROR_CODES.policyViolation,
  compose_failed: SERVICE_ERROR_CODES.composeFailed,
  busy: SERVICE_ERROR_CODES.busy,
  unknown_entry: SERVICE_ERROR_CODES.catalogEntryNotFound,
};

/** The backup wrapper's `@@error` codes → ours (most are the same words). */
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
  paths_changed: BACKUP_ERROR_CODES.pathsChanged,
  item_not_found: BACKUP_ERROR_CODES.itemNotFound,
  not_configured: BACKUP_ERROR_CODES.notConfigured,
  not_found: BACKUP_ERROR_CODES.restoreNotFound,
  invalid_plan: BACKUP_ERROR_CODES.invalidPlan,
};

/** The disk wrapper's `@@error` codes → ours (the same words). */
const DISK_CODES: Record<string, DiskErrorCode> = Object.fromEntries(
  Object.values(DISK_ERROR_CODES).map((code) => [code, code]),
);

/** Mounting waits for systemd; a slow USB disk takes seconds. */
export const DISK_TIMEOUT_MS = 2 * 60_000;

export const COMPOSE: WrapperKind<ServiceErrorCode> = {
  name: 'compose',
  label: 'deploy',
  // Its reasons may name a form's values: only the code is logged.
  logsReason: false,
  codes: COMPOSE_CODES,
  failed: SERVICE_ERROR_CODES.composeFailed,
  unavailable: SERVICE_ERROR_CODES.executorUnavailable,
  timedOut: SERVICE_ERROR_CODES.timedOut,
};

export const BACKUP: WrapperKind<BackupErrorCode> = {
  name: 'backup',
  label: 'backup',
  logsReason: true,
  codes: BACKUP_CODES,
  failed: BACKUP_ERROR_CODES.borgFailed,
  unavailable: BACKUP_ERROR_CODES.executorUnavailable,
  timedOut: BACKUP_ERROR_CODES.timedOut,
};

export const DISK: WrapperKind<DiskErrorCode> = {
  name: 'disk',
  label: 'disk',
  logsReason: true,
  codes: DISK_CODES,
  failed: DISK_ERROR_CODES.mountFailed,
  unavailable: DISK_ERROR_CODES.executorUnavailable,
  timedOut: DISK_ERROR_CODES.timedOut,
};
