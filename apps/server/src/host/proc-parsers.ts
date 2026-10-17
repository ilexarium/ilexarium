import type {
  CpuTimes,
  MemoryInfo,
  Mount,
  MountPoint,
  NetCounters,
  ProcStat,
} from './host.model.js';
// Pure parsers for the Linux files system metrics come from (see proc(5) and os-release(5)).
// No file access here — `SystemReader` reads, these turn text into numbers.

/**
 * The aggregate `cpu` line of `/proc/stat`: user nice system idle iowait irq softirq steal
 * (guest and guest_nice are already counted in user and nice, so they are left out).
 */
export function parseCpuTimes(stat: string): CpuTimes {
  const line = stat.split('\n').find((l) => l.startsWith('cpu '));
  if (!line) throw new Error('/proc/stat has no aggregate cpu line');
  const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = line
    .trim()
    .split(/\s+/)
    .slice(1)
    .map(Number);
  return {
    idle: idle + iowait,
    total: user + nice + system + idle + iowait + irq + softirq + steal,
  };
}

/** Busy share of the time between two readings, 0–100. */
export function cpuUsagePercent(previous: CpuTimes, current: CpuTimes): number {
  const total = current.total - previous.total;
  if (total <= 0) return 0;
  const busy = total - (current.idle - previous.idle);
  return Math.min(100, Math.max(0, (busy / total) * 100));
}

/** `/proc/meminfo`; values there are in kB (KiB). */
export function parseMeminfo(meminfo: string): MemoryInfo {
  const kib = new Map<string, number>();
  for (const line of meminfo.split('\n')) {
    const match = /^(\w+(?:\(\w+\))?):\s+(\d+)/.exec(line);
    if (match) kib.set(match[1], Number(match[2]));
  }
  const get = (key: string) => (kib.get(key) ?? 0) * 1024;
  if (!kib.has('MemTotal')) throw new Error('/proc/meminfo has no MemTotal');
  // MemAvailable exists since Linux 3.14; before that, approximate it like `free` did.
  const availableBytes = kib.has('MemAvailable')
    ? get('MemAvailable')
    : get('MemFree') + get('Buffers') + get('Cached');
  return {
    totalBytes: get('MemTotal'),
    availableBytes,
    swapTotalBytes: get('SwapTotal'),
    swapFreeBytes: get('SwapFree'),
  };
}

/** `/proc/net/dev`: two header lines, then `name: rx_bytes … (8 rx fields) tx_bytes …`. */
export function parseNetDev(netDev: string): Map<string, NetCounters> {
  const counters = new Map<string, NetCounters>();
  for (const line of netDev.split('\n').slice(2)) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const fields = line
      .slice(colon + 1)
      .trim()
      .split(/\s+/)
      .map(Number);
    if (fields.length < 9) continue;
    counters.set(line.slice(0, colon).trim(), { rxBytes: fields[0], txBytes: fields[8] });
  }
  return counters;
}

const HIDDEN_INTERFACE = /^(lo|docker0|br-.*|veth.*)$/;

/** Physical interfaces and VPNs like `tailscale0`; not loopback or Docker's virtual ones. */
export function isShownInterface(name: string): boolean {
  return !HIDDEN_INTERFACE.test(name);
}

/** Bytes per second between two readings `seconds` apart; 0 after a counter reset. */
export function bytesPerSecond(previous: number, current: number, seconds: number): number {
  if (seconds <= 0 || current < previous) return 0;
  return (current - previous) / seconds;
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

/** `/proc/self/mounts` (fstab format; spaces and the like octal-escaped, e.g. `\040`). */
export function parseMounts(mounts: string): Mount[] {
  const unescape = (field: string) =>
    field.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
  return mounts
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length >= 3)
    .map(([device, mount, fsType]) => ({
      device: unescape(device),
      mount: unescape(mount),
      fsType,
    }));
}

/**
 * `/proc/self/mountinfo`: every mount point with its file system type and device (`major:minor`).
 * Unlike /proc/self/mounts it names bind mounts' roots and is what the backup wrapper reads.
 */
export function parseMountInfo(mountInfo: string): MountPoint[] {
  const unescape = (field: string) =>
    field.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
  const points: MountPoint[] = [];
  for (const line of mountInfo.split('\n')) {
    const [before, after] = line.split(' - ');
    if (!after) continue;
    const fields = before.split(' ');
    const [fsType, source] = after.split(' ');
    if (fields.length < 5 || !fsType) continue;
    points.push({
      mount: unescape(fields[4]),
      device: fields[2],
      fsType,
      source: unescape(source ?? ''),
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

/** `PRETTY_NAME` from os-release, else `NAME`; null if neither is there. */
export function parseOsRelease(osRelease: string): string | null {
  const values = new Map<string, string>();
  for (const line of osRelease.split('\n')) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match) values.set(match[1], match[2].replace(/^(["'])(.*)\1$/, '$2'));
  }
  return values.get('PRETTY_NAME') || values.get('NAME') || null;
}

/**
 * TCP ports something listens on, from `/proc/net/tcp` or `tcp6`: each line's `local_address` is
 * `ADDR:PORT` in hex, and state `0A` is LISTEN.
 */
export function parseListeningTcpPorts(netTcp: string): Set<number> {
  const ports = new Set<number>();
  for (const line of netTcp.split('\n').slice(1)) {
    const columns = line.trim().split(/\s+/);
    const port = columns[1]?.split(':')[1];
    if (columns[3] === '0A' && port) ports.add(parseInt(port, 16));
  }
  return ports;
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
export const DISK_UNIT_MARKER = '# Managed by homelab (homelab-disk).';

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

/** PF_KTHREAD in a process's flags: a kernel thread. */
const PF_KTHREAD = 0x0020_0000;

/** A kernel thread, by its flags (`/proc/<pid>/stat` field 9). */
export function isKernelThread(stat: Pick<ProcStat, 'flags'>): boolean {
  return (stat.flags & PF_KTHREAD) !== 0;
}

/**
 * `/proc/<pid>/stat`. The name sits in parentheses and may itself hold spaces and `)`, so the
 * fields are counted from the **last** `)`: state is field 3, flags 9, utime 14, stime 15,
 * starttime 22. Null for anything else (the process ended while being read).
 */
export function parseProcStat(stat: string): ProcStat | null {
  const open = stat.indexOf('(');
  const close = stat.lastIndexOf(')');
  if (open < 1 || close < open) return null;
  const pid = Number(stat.slice(0, open).trim());
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  // fields[0] is field 3 (state).
  const field = (n: number) => fields[n - 3];
  const startTicks = field(22);
  if (!Number.isInteger(pid) || pid <= 0 || !startTicks || !/^\d+$/.test(startTicks)) return null;
  return {
    pid,
    name: stat.slice(open + 1, close),
    state: field(3),
    flags: Number(field(9)),
    cpuTicks: Number(field(14)) + Number(field(15)),
    startTicks,
  };
}

/** `/proc/<pid>/status`: its four uids and its resident memory (VmRSS, absent for kernel threads). */
export function parseProcStatus(
  status: string,
): { uids: [number, number, number, number]; rssBytes: number } | null {
  const uidLine = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(status);
  if (!uidLine) return null;
  const rss = /^VmRSS:\s+(\d+)\s*kB/m.exec(status);
  const uids = uidLine.slice(1, 5).map(Number) as [number, number, number, number];
  return { uids, rssBytes: rss ? Number(rss[1]) * 1024 : 0 };
}

/** `/proc/<pid>/cmdline`: arguments separated (and ended) by NUL bytes. */
export function parseCmdline(cmdline: string): string {
  return cmdline.replace(/\0+$/, '').replace(/\0/g, ' ');
}

/**
 * The container a process runs in, from `/proc/<pid>/cgroup`: Docker's ID (cgroup v2
 * `…/docker-<id>.scope`, v1 `/docker/<id>`), Podman's (`libpod-<id>`), containerd's — or `''`
 * for a container whose ID isn't there; null outside containers.
 */
export function parseContainerId(cgroup: string): string | null {
  const id = /(?:docker|libpod|containerd)[-/]([0-9a-f]{64})/.exec(cgroup);
  if (id) return id[1];
  return /\/(?:docker|libpod|kubepods|containerd|lxc)\b/.test(cgroup) ? '' : null;
}

/** `/etc/passwd`: uid → account name. */
export function parsePasswd(passwd: string): Map<number, string> {
  const users = new Map<number, string>();
  for (const line of passwd.split('\n')) {
    const [name, , uid] = line.split(':');
    if (name && uid && /^\d+$/.test(uid) && !users.has(Number(uid))) users.set(Number(uid), name);
  }
  return users;
}

/** `btime` of `/proc/stat`: when the machine booted, in seconds since 1970. */
export function parseBootTime(stat: string): number | null {
  const match = /^btime\s+(\d+)/m.exec(stat);
  return match ? Number(match[1]) : null;
}

/**
 * Whether /proc hides other users' processes (`hidepid=1|2`, `invisible`, `noaccess` on its
 * mount in `/proc/self/mounts`): then the list is incomplete.
 */
export function procHidesProcesses(mounts: string): boolean {
  for (const line of mounts.split('\n')) {
    const [, mount, fsType, options = ''] = line.trim().split(/\s+/);
    if (mount !== '/proc' || fsType !== 'proc') continue;
    return options.split(',').some((option) => /^hidepid=(1|2|noaccess|invisible)$/.test(option));
  }
  return false;
}
