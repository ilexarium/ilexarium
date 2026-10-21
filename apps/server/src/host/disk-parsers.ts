import type { Mount, MountPoint } from './host.model.js';

/** Mount tables write spaces and the like as octal escapes, e.g. `\040`. */
function unescapeOctal(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(parseInt(octal, 8)),
  );
}

/** Pseudo, in-memory and image filesystems: nothing a user would call a disk. */
const PSEUDO_FS_TYPES = new Set([
  'autofs',
  'binfmt_misc',
  'bpf',
  'cgroup',
  'cgroup2',
  'configfs',
  'debugfs',
  'devpts',
  'devtmpfs',
  'efivarfs',
  'fusectl',
  'hugetlbfs',
  'mqueue',
  'nsfs',
  'overlay',
  'proc',
  'pstore',
  'ramfs',
  'rpc_pipefs',
  'securityfs',
  'selinuxfs',
  'squashfs',
  'sysfs',
  'tmpfs',
  'tracefs',
]);

/** `statfs()` on a hung network share can block a worker thread indefinitely — skipped for now. */
const NETWORK_FS_TYPES = new Set(['nfs', 'nfs4', 'cifs', 'smb3', 'fuse.sshfs', 'sshfs', '9p']);

/** `/proc/self/mounts` (fstab format). */
export function parseMounts(mounts: string): Mount[] {
  return mounts
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length >= 3)
    .map(([device, mount, fsType]) => ({
      device: unescapeOctal(device),
      mount: unescapeOctal(mount),
      fsType,
    }));
}

/**
 * `/proc/self/mountinfo`: every mount point with its file system type and device (`major:minor`).
 * Unlike /proc/self/mounts it names bind mounts' roots and is what the backup wrapper reads.
 */
export function parseMountInfo(mountInfo: string): MountPoint[] {
  const points: MountPoint[] = [];
  for (const line of mountInfo.split('\n')) {
    const [before, after] = line.split(' - ');
    if (!after) continue;
    const fields = before.split(' ');
    const [fsType, source] = after.split(' ');
    if (fields.length < 5 || !fsType) continue;
    points.push({
      mount: unescapeOctal(fields[4]),
      device: fields[2],
      fsType,
      source: unescapeOctal(source ?? ''),
    });
  }
  return points;
}

/** Real local filesystems, one per device (the first mount of a device — usually the main one). */
export function diskMounts(mounts: Mount[]): Mount[] {
  const seen = new Set<string>();
  return mounts.filter(({ device, fsType }) => {
    if (PSEUDO_FS_TYPES.has(fsType) || NETWORK_FS_TYPES.has(fsType)) return false;
    if (seen.has(device)) return false;
    seen.add(device);
    return true;
  });
}

/** udev's database entry of a device (`/run/udev/data/b<major>:<minor>`): its `E:` properties. */
export function parseUdevData(data: string): Map<string, string> {
  const properties = new Map<string, string>();
  for (const line of data.split('\n')) {
    const match = /^E:([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match) properties.set(match[1], match[2]);
  }
  return properties;
}

/** `/proc/swaps`: the kernel names of the devices used as swap (files left out). */
export function parseSwaps(swaps: string): string[] {
  return swaps
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/)[0] ?? '')
    .filter((file) => file.startsWith('/dev/'))
    .map((file) => file.slice(file.lastIndexOf('/') + 1));
}

/** The first line of every mount unit the disk wrapper writes. */
export const DISK_UNIT_MARKER = '# Managed by laris (laris-disk).';

/** A mount unit the disk wrapper wrote: its disk (by UUID) and folder; null for anyone else's. */
export function parseDiskUnit(unit: string): { uuid: string | null; where: string } | null {
  if (!unit.startsWith(`${DISK_UNIT_MARKER}\n`)) return null;
  const value = (key: string) => new RegExp(`^${key}=(.*)$`, 'm').exec(unit)?.[1] ?? null;
  const where = value('Where');
  if (!where) return null;
  const what = value('What');
  const uuid = what?.startsWith('/dev/disk/by-uuid/') ? what.slice(18) : null;
  return { uuid, where };
}
