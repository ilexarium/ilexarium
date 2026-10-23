import {
  DISK_ERROR_CODES,
  DISK_MOUNT_ROOT,
  type DiskErrorCode,
  type DiskPartitionState,
} from '@laris/shared';

/** Production places; development reads and writes under the config's pretend host. */
export const ROOT_PLACES = {
  host: '/',
  mountRoot: DISK_MOUNT_ROOT,
  unitDir: '/etc/systemd/system',
};

/** Per IP, for changes (privileged, rare); reads aren't limited. */
export const CHANGE_LIMIT = { default: { limit: 20, ttl: 60_000 } };

/** Changes come in bursts (a disk's partitions appear one by one): at most one update this often. */
export const DISKS_PUBLISH_MS = 300;
/** Looked at again this often anyway (mounts made outside the app, a missed notice). */
export const DISKS_POLL_MS = 5_000;

/** Folders whose disk is the system's: every partition on such a disk is shown as `system`. */
export const SYSTEM_MOUNTS = ['/', '/boot', '/boot/efi', '/efi', '/home', '/var', '/usr'];

/** Filesystem types of devices that belong to something else (swap, RAID, LVM, encryption). */
export const MEMBER_TYPES = new Set(['swap', 'linux_raid_member', 'LVM2_member', 'crypto_LUKS']);

/** Layers made of other devices, not disks of their own (device-mapper, software RAID). */
export const VIRTUAL = /^(dm-|md)/;

/** Partition states that can't be mounted, and the error each gives. */
export const MOUNT_REFUSED: Partial<Record<DiskPartitionState, DiskErrorCode>> = {
  system: DISK_ERROR_CODES.systemDisk,
  mounted: DISK_ERROR_CODES.diskInUse,
  inUse: DISK_ERROR_CODES.diskInUse,
  unsupported: DISK_ERROR_CODES.unsupportedFilesystem,
};
