import type { CpuTimes, MemoryInfo, NetCounters } from './host.model.js';

// The files the system metrics come from (proc(5), os-release(5)). `SystemReader` reads them.

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
