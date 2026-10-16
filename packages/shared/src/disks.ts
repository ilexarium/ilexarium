import { z } from 'zod';
import { VALIDATION_LIMITS } from './auth.js';

/**
 * Disk management (docs/plans/disk_management.md): disks and their partitions as the server
 * reads them, and mounting one at `/mnt/<name>` — kept after a restart, its own systemd unit.
 */

/** Filesystems a disk may be mounted with — the backups' list (exFAT: most USB disks). */
export const DISK_FILESYSTEMS = ['ext4', 'xfs', 'btrfs', 'exfat'] as const;

/** Where disks are mounted: `/mnt/<name>`. */
export const DISK_MOUNT_ROOT = '/mnt';

/** A mount's name: its folder under `/mnt`, lowercase letters, digits and `-`. */
export const DISK_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const DISK_NAME_MAX = VALIDATION_LIMITS.diskNameMax;

/** A filesystem UUID as udev names it (ext4/xfs/btrfs: 36 characters; exFAT: XXXX-XXXX). */
export const DISK_UUID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

export const DISK_ERROR_CODES = {
  /** No disk with that UUID now (unplugged meanwhile). */
  diskNotFound: 'disk_not_found',
  /** Mounted already, swap, or used by another device (RAID, LVM, encryption). */
  diskInUse: 'disk_in_use',
  /** On the disk the system runs from: never touched. */
  systemDisk: 'system_disk',
  unsupportedFilesystem: 'unsupported_filesystem',
  /** Another device has the same filesystem UUID (a copied disk): either could be mounted. */
  duplicateUuid: 'duplicate_uuid',
  /** `/mnt/<name>` is taken (a folder with files, a link, another disk). */
  nameTaken: 'name_taken',
  /** Not a disk mounted here (only ours are unmounted). */
  notManaged: 'not_managed',
  /** The backups are kept on it. */
  usedForBackups: 'used_for_backups',
  /** Another operation is running. */
  busy: 'busy',
  /** Files on the disk are open: it can't be unmounted now. */
  diskBusy: 'disk_busy',
  mountFailed: 'mount_failed',
  unmountFailed: 'unmount_failed',
  invalidRequest: 'invalid_request',
  timedOut: 'timed_out',
  executorUnavailable: 'executor_unavailable',
  auditUnavailable: 'audit_unavailable',
} as const;
export type DiskErrorCode = (typeof DISK_ERROR_CODES)[keyof typeof DISK_ERROR_CODES];

/**
 * - `mounted`: mounted somewhere (`mountPoint`); `managed` when mounted here.
 * - `available`: can be mounted.
 * - `system`: on the disk the system runs from.
 * - `inUse`: swap, or part of RAID, LVM or encryption.
 * - `unsupported`: another filesystem, or none.
 */
export const DISK_PARTITION_STATES = [
  'mounted',
  'available',
  'system',
  'inUse',
  'unsupported',
] as const;
export const diskPartitionStateSchema = z.enum(DISK_PARTITION_STATES);
export type DiskPartitionState = z.infer<typeof diskPartitionStateSchema>;

/** A partition — or a disk formatted whole, listed as its own only partition. */
export const diskPartitionSchema = z.object({
  /** The kernel's name (`sdb1`). */
  device: z.string(),
  uuid: z.string().nullable(),
  label: z.string().nullable(),
  fsType: z.string().nullable(),
  sizeBytes: z.number().nonnegative(),
  state: diskPartitionStateSchema,
  mountPoint: z.string().nullable(),
  /** Mounted by this app (its name under `/mnt`), so it can be unmounted here. */
  managedName: z.string().nullable(),
  usedForBackups: z.boolean(),
  /** Another device has the same UUID (a copied disk): not mounted here while both are connected. */
  duplicateUuid: z.boolean(),
});
export type DiskPartition = z.infer<typeof diskPartitionSchema>;

export const diskSchema = z.object({
  device: z.string(),
  model: z.string().nullable(),
  sizeBytes: z.number().nonnegative(),
  removable: z.boolean(),
  /** The system runs from it: nothing on it can be mounted or unmounted here. */
  system: z.boolean(),
  partitions: z.array(diskPartitionSchema),
});
export type Disk = z.infer<typeof diskSchema>;

/** A disk mounted here that isn't connected now: it's mounted again when it is. */
export const disconnectedDiskSchema = z.object({
  name: z.string(),
  mountPoint: z.string(),
  uuid: z.string().nullable(),
  usedForBackups: z.boolean(),
});
export type DisconnectedDisk = z.infer<typeof disconnectedDiskSchema>;

/** The `disks` topic and `GET /disks`. */
export const disksStatusSchema = z.object({
  disks: z.array(diskSchema),
  disconnected: z.array(disconnectedDiskSchema),
});
export type DisksStatus = z.infer<typeof disksStatusSchema>;

export const diskNameSchema = z
  .string()
  .min(1, 'validation.diskNameRequired')
  .regex(DISK_NAME_PATTERN, 'validation.diskNameInvalid');

export const diskMountRequestSchema = z.strictObject({
  uuid: z.string().regex(DISK_UUID_PATTERN, 'validation.diskUuidInvalid'),
  name: diskNameSchema,
});
export type DiskMountRequest = z.infer<typeof diskMountRequestSchema>;

export const diskNameParamsSchema = z.strictObject({ name: diskNameSchema });
export type DiskNameParams = z.infer<typeof diskNameParamsSchema>;

export const diskMountedResponseSchema = z.object({ mountPoint: z.string() });
export type DiskMountedResponse = z.infer<typeof diskMountedResponseSchema>;

/**
 * A name for a disk from its label: lowercase, `-` for anything else, trimmed to the pattern —
 * the mount dialog's suggestion (`disk` when nothing usable is left).
 */
export function suggestDiskName(label: string | null, taken: readonly string[] = []): string {
  const base =
    (label ?? '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, DISK_NAME_MAX - 3)
      .replace(/-+$/, '') || 'disk';
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) {
    const name = `${base}-${i}`;
    if (!taken.includes(name)) return name;
  }
}
