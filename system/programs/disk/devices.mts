// disk/devices.mts — runs as root.
//
// Block devices as the kernel and udev describe them (/sys/class/block, /run/udev/data), what's
// mounted (mountinfo) and what's swap — read by this program itself, never taken from the app.

import { existsSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Device, Mount, Paths } from './model.mts';

/** A kernel block device name (sda1, nvme0n1p2, mmcblk0p1, dm-0). */
export const KERNEL_NAME = /^[a-z][a-z0-9-]{1,31}$/;

/** Folders whose disk is the system's: every partition on such a disk is refused. */
export const SYSTEM_MOUNTS = ['/', '/boot', '/boot/efi', '/efi', '/home', '/var', '/usr'];

/** Not disks: memory, loop and optical devices. */
const VIRTUAL = /^(loop|ram|zram|sr|fd)\d/;

const read = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
};

const list = (path: string): string[] => {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
};

export function sysBlock(paths: Paths): string {
  return join(paths.host, 'sys/class/block');
}

/** Every block device, by kernel name. */
export function readDevices(paths: Paths): Map<string, Device> {
  const root = sysBlock(paths);
  const names = list(root).filter((n) => KERNEL_NAME.test(n) && !VIRTUAL.test(n));
  const devices = new Map<string, Device>();
  for (const name of names) {
    const dir = join(root, name);
    const number = read(join(dir, 'dev'));
    if (!number || !/^\d+:\d+$/.test(number)) continue;
    const udev = udevProperties(paths, number);
    devices.set(name, {
      name,
      number,
      disk: name,
      partition: existsSync(join(dir, 'partition')),
      partitions: [],
      holders: list(join(dir, 'holders')),
      slaves: list(join(dir, 'slaves')),
      fsType: udev.get('ID_FS_TYPE') ?? null,
      uuid: udev.get('ID_FS_UUID') ?? null,
    });
  }
  // A partition's disk: the disk whose sysfs folder holds a folder of the partition's name.
  for (const disk of devices.values()) {
    if (disk.partition) continue;
    for (const entry of list(join(root, disk.name))) {
      const part = devices.get(entry);
      if (part?.partition) {
        part.disk = disk.name;
        disk.partitions.push(part.name);
      }
    }
  }
  return devices;
}

/** udev's properties of a device (`E:KEY=value` lines). */
export function udevProperties(paths: Paths, number: string): Map<string, string> {
  const properties = new Map<string, string>();
  const text = read(join(paths.host, 'run/udev/data', `b${number}`)) ?? '';
  for (const line of text.split('\n')) {
    const match = /^E:([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match) properties.set(match[1], match[2]);
  }
  return properties;
}

/** mountinfo: each mount's device number, mount point (unescaped) and source. */
export function readMounts(paths: Paths): Mount[] {
  const text = read(join(paths.host, 'proc/self/mountinfo')) ?? '';
  const mounts: Mount[] = [];
  for (const line of text.split('\n')) {
    const fields = line.split(' ');
    const dash = fields.indexOf('-');
    if (fields.length < 10 || dash < 6) continue;
    mounts.push({
      number: fields[2],
      point: unescapeOctal(fields[4]),
      source: unescapeOctal(fields[dash + 2] ?? ''),
    });
  }
  return mounts;
}

const unescapeOctal = (text: string) =>
  text.replace(/\\([0-7]{3})/g, (_, code: string) => String.fromCharCode(parseInt(code, 8)));

/** Swap in use: the kernel names of its devices. */
export function readSwaps(paths: Paths): Set<string> {
  const text = read(join(paths.host, 'proc/swaps')) ?? '';
  return new Set(
    text
      .split('\n')
      .slice(1)
      .map((line) => line.split(/\s+/)[0])
      .filter((file) => file?.startsWith('/dev/'))
      .map((file) => basename(file)),
  );
}

/** Whether a device is mounted: by its number, or as the source of a mount (btrfs shows 0:n). */
export function mountsOf(device: Device, mounts: Mount[]): Mount[] {
  return mounts.filter((m) => m.number === device.number || m.source === `/dev/${device.name}`);
}

/**
 * The disks the system runs from: those under the system folders' mounts, through device-mapper
 * and RAID layers (`slaves`) down to the physical disks.
 */
export function systemDisks(devices: Map<string, Device>, mounts: Mount[]): Set<string> {
  const disks = new Set<string>();
  const visit = (name: string, depth: number) => {
    const device = devices.get(name);
    if (!device || depth > 8) return;
    disks.add(device.disk);
    for (const slave of device.slaves) visit(slave, depth + 1);
  };
  for (const mount of mounts.filter((m) => SYSTEM_MOUNTS.includes(m.point))) {
    for (const device of devices.values()) {
      if (mountsOf(device, [mount]).length > 0) visit(device.name, 0);
    }
  }
  return disks;
}

/** The kernel name /dev/disk/by-uuid/<uuid> points to, or null. */
export function deviceByUuid(paths: Paths, uuid: string): string | null {
  try {
    const name = basename(readlinkSync(join(paths.host, 'dev/disk/by-uuid', uuid)));
    return KERNEL_NAME.test(name) ? name : null;
  } catch {
    return null;
  }
}
