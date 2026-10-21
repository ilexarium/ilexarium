import {
  DISK_FILESYSTEMS,
  type DisconnectedDisk,
  type Disk,
  type DiskPartition,
  type DiskPartitionState,
  type DisksStatus,
} from '@laris/shared';
import type { BlockDevice, MountPoint } from '../host/host.model.js';

/** Folders whose disk is the system's: every partition on such a disk is shown as `system`. */
export const SYSTEM_MOUNTS = ['/', '/boot', '/boot/efi', '/efi', '/home', '/var', '/usr'];

/** Filesystem types of devices that belong to something else (swap, RAID, LVM, encryption). */
const MEMBER_TYPES = new Set(['swap', 'linux_raid_member', 'LVM2_member', 'crypto_LUKS']);

/** Layers made of other devices, not disks of their own (device-mapper, software RAID). */
const VIRTUAL = /^(dm-|md)/;

export interface DisksInput {
  devices: BlockDevice[];
  mounts: MountPoint[];
  swaps: string[];
  /** The mount units the disk wrapper wrote. */
  units: { name: string; uuid: string | null; where: string }[];
  /** Where the backups are kept (the database's plan), if set up. */
  backupDestination: string | null;
}

const inside = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

/** The mounts of a device: by its number, or by name as their source (btrfs shows `0:n`). */
function mountsOf(device: BlockDevice, mounts: MountPoint[]): MountPoint[] {
  return mounts.filter((m) => m.device === device.number || m.source === `/dev/${device.name}`);
}

/** The disks the system runs from — under device-mapper and RAID layers too. */
export function systemDisks(devices: BlockDevice[], mounts: MountPoint[]): Set<string> {
  const byName = new Map(devices.map((d) => [d.name, d]));
  const disks = new Set<string>();
  const visit = (name: string, depth: number) => {
    const device = byName.get(name);
    if (!device || depth > 8) return;
    disks.add(device.disk);
    for (const slave of device.slaves) visit(slave, depth + 1);
  };
  const systemMounts = mounts.filter((m) => SYSTEM_MOUNTS.includes(m.mount));
  for (const device of devices) {
    if (mountsOf(device, systemMounts).length > 0) visit(device.name, 0);
  }
  return disks;
}

/** What the Disks page shows: every disk with its partitions' states, and disks gone missing. */
export function disksStatus(input: DisksInput): DisksStatus {
  const { devices, mounts, units, backupDestination } = input;
  const byName = new Map(devices.map((d) => [d.name, d]));
  const system = systemDisks(devices, mounts);
  const swaps = new Set(input.swaps);
  const uuids = devices.map((d) => d.uuid).filter((uuid) => uuid !== null);
  const duplicated = new Set(uuids.filter((uuid, i) => uuids.indexOf(uuid) !== i));
  const forBackups = (point: string | null) =>
    point !== null && backupDestination !== null && inside(backupDestination, point);

  const partition = (device: BlockDevice, onSystemDisk: boolean): DiskPartition => {
    const mountPoint = mountsOf(device, mounts)[0]?.mount ?? null;
    const unit = device.uuid ? units.find((u) => u.uuid === device.uuid) : undefined;
    let state: DiskPartitionState;
    if (onSystemDisk) state = 'system';
    else if (mountPoint) state = 'mounted';
    else if (
      swaps.has(device.name) ||
      device.holders.length > 0 ||
      MEMBER_TYPES.has(device.fsType ?? '')
    ) {
      state = 'inUse';
    } else if ((DISK_FILESYSTEMS as readonly string[]).includes(device.fsType ?? '')) {
      state = 'available';
    } else state = 'unsupported';
    return {
      device: device.name,
      uuid: device.uuid,
      label: device.label,
      fsType: device.fsType,
      sizeBytes: device.sizeBytes,
      state,
      mountPoint,
      managedName: unit?.name ?? null,
      usedForBackups: forBackups(mountPoint),
      duplicateUuid: device.uuid !== null && duplicated.has(device.uuid),
    };
  };

  const disks: Disk[] = devices
    .filter((d) => !d.partition && !VIRTUAL.test(d.name))
    .map((disk) => {
      const onSystemDisk = system.has(disk.name);
      const parts = disk.partitions.map((name) => byName.get(name)).filter((p) => p !== undefined);
      return {
        device: disk.name,
        model: disk.model,
        sizeBytes: disk.sizeBytes,
        removable: disk.removable,
        system: onSystemDisk,
        // A disk formatted whole is its own only partition.
        partitions: (parts.length > 0 ? parts : disk.fsType ? [disk] : []).map((p) =>
          partition(p, onSystemDisk),
        ),
      };
    })
    .sort((a, b) => Number(a.system) - Number(b.system) || a.device.localeCompare(b.device));

  const present = new Set(devices.map((d) => d.uuid).filter((uuid) => uuid !== null));
  const disconnected: DisconnectedDisk[] = units
    .filter((unit) => !unit.uuid || !present.has(unit.uuid))
    .map((unit) => ({
      name: unit.name,
      mountPoint: unit.where,
      uuid: unit.uuid,
      usedForBackups: forBackups(unit.where),
    }));
  return { disks, disconnected };
}
