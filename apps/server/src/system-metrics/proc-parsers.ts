// Pure parsers for the Linux files system metrics come from (see proc(5) and os-release(5)).
// No file access here — `SystemReader` reads, these turn text into numbers.

/** Cumulative CPU time since boot, in clock ticks, across all cores. */
export interface CpuTimes {
  idle: number;
  total: number;
}

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

export interface MemoryInfo {
  totalBytes: number;
  availableBytes: number;
  swapTotalBytes: number;
  swapFreeBytes: number;
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

/** Cumulative bytes since the interface came up. */
export interface NetCounters {
  rxBytes: number;
  txBytes: number;
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

export interface Mount {
  device: string;
  mount: string;
  fsType: string;
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
