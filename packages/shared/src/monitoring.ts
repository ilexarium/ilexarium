import { z } from 'zod';

// Data carried by the `system` and `containers` realtime topics. The server sends raw numbers
// (bytes, bytes per second, percent; timestamps as epoch milliseconds) — formatting is the web's job.

const bytes = z.number().nonnegative();
const bytesPerSec = z.number().nonnegative();
const percent = z.number().nonnegative();
const epochMs = z.number().int().nonnegative();

// System.

export const hostInfoSchema = z.object({
  hostname: z.string(),
  /** Distribution name and release, e.g. "Arch Linux" or "Debian GNU/Linux 13". */
  os: z.string(),
  kernel: z.string(),
  arch: z.string(),
  cpuModel: z.string(),
  cpuCores: z.number().int().positive(),
});
export type HostInfo = z.infer<typeof hostInfoSchema>;

export const networkInterfaceStatsSchema = z.object({
  name: z.string(),
  rxBytesPerSec: bytesPerSec,
  txBytesPerSec: bytesPerSec,
});
export type NetworkInterfaceStats = z.infer<typeof networkInterfaceStatsSchema>;

/** Taken every 2 s. */
export const systemSampleSchema = z.object({
  at: epochMs,
  cpu: z.object({
    /** 0–100, across all cores. */
    usagePercent: percent.max(100),
    /** 1, 5 and 15 minutes. */
    loadAverage: z.tuple([
      z.number().nonnegative(),
      z.number().nonnegative(),
      z.number().nonnegative(),
    ]),
  }),
  memory: z.object({
    totalBytes: bytes,
    /** Excludes buffers and page cache. */
    usedBytes: bytes,
    availableBytes: bytes,
    swapTotalBytes: bytes,
    swapUsedBytes: bytes,
  }),
  /** Real interfaces only; the server leaves out loopback and Docker's virtual ones. */
  network: z.array(networkInterfaceStatsSchema),
});
export type SystemSample = z.infer<typeof systemSampleSchema>;

/** One per real mounted filesystem (refreshed every 30 s). */
export const diskUsageSchema = z.object({
  device: z.string(),
  mount: z.string(),
  fsType: z.string(),
  sizeBytes: bytes,
  usedBytes: bytes,
});
export type DiskUsage = z.infer<typeof diskUsageSchema>;

/** One chart point; network is summed over the sample's interfaces. */
export const systemHistoryPointSchema = z.object({
  at: epochMs,
  cpuPercent: percent,
  memoryUsedBytes: bytes,
  rxBytesPerSec: bytesPerSec,
  txBytesPerSec: bytesPerSec,
});
export type SystemHistoryPoint = z.infer<typeof systemHistoryPointSchema>;

/** The chart point for a sample — used by the server's ring buffer and the web's live charts alike. */
export function toSystemHistoryPoint(sample: SystemSample): SystemHistoryPoint {
  let rxBytesPerSec = 0;
  let txBytesPerSec = 0;
  for (const iface of sample.network) {
    rxBytesPerSec += iface.rxBytesPerSec;
    txBytesPerSec += iface.txBytesPerSec;
  }
  return {
    at: sample.at,
    cpuPercent: sample.cpu.usagePercent,
    memoryUsedBytes: sample.memory.usedBytes,
    rxBytesPerSec,
    txBytesPerSec,
  };
}

export const systemUpdateSchema = z.object({
  uptimeSeconds: z.number().nonnegative(),
  sample: systemSampleSchema,
  disks: z.array(diskUsageSchema),
});
export type SystemUpdate = z.infer<typeof systemUpdateSchema>;

export const systemSnapshotSchema = systemUpdateSchema.extend({
  host: hostInfoSchema,
  /** Up to the last 15 minutes, oldest first. */
  history: z.array(systemHistoryPointSchema),
});
export type SystemSnapshot = z.infer<typeof systemSnapshotSchema>;

// Containers.

export const CONTAINER_STATES = [
  'created',
  'running',
  'paused',
  'restarting',
  'removing',
  'exited',
  'dead',
] as const;
export const containerStateSchema = z.enum(CONTAINER_STATES);
export type ContainerState = z.infer<typeof containerStateSchema>;

/** `none` when the image defines no health check. */
export const CONTAINER_HEALTH = ['healthy', 'unhealthy', 'starting', 'none'] as const;
export const containerHealthSchema = z.enum(CONTAINER_HEALTH);
export type ContainerHealth = z.infer<typeof containerHealthSchema>;

export const containerPortSchema = z.object({
  privatePort: z.number().int().min(1).max(65535),
  /** Absent when the port is exposed but not published on the host. */
  publicPort: z.number().int().min(1).max(65535).optional(),
  /** Host address the port is published on, e.g. "0.0.0.0" or "127.0.0.1". */
  ip: z.string().optional(),
  protocol: z.enum(['tcp', 'udp', 'sctp']),
});
export type ContainerPort = z.infer<typeof containerPortSchema>;

/** Live resource use of a running container. I/O counters are totals since it started, like `docker stats`. */
export const containerStatsSchema = z.object({
  at: epochMs,
  /** Docker CLI formula: may exceed 100 on multi-core hosts (100 = one full core). */
  cpuPercent: percent,
  /** Excludes page cache, like `docker stats`. */
  memoryUsedBytes: bytes,
  memoryLimitBytes: bytes,
  netRxBytes: bytes,
  netTxBytes: bytes,
  blockReadBytes: bytes,
  blockWriteBytes: bytes,
});
export type ContainerStats = z.infer<typeof containerStatsSchema>;

export const containerSchema = z.object({
  id: z.string(),
  /** Without Docker's leading slash. */
  name: z.string(),
  image: z.string(),
  state: containerStateSchema,
  health: containerHealthSchema,
  /** ISO timestamp of the last start; null if it never started. */
  startedAt: z.iso.datetime().nullable(),
  ports: z.array(containerPortSchema),
  /** Null when not running, or before its first stats sample arrives. */
  stats: containerStatsSchema.nullable(),
});
export type Container = z.infer<typeof containerSchema>;

export const containerHistoryPointSchema = z.object({
  at: epochMs,
  cpuPercent: percent,
  memoryUsedBytes: bytes,
});
export type ContainerHistoryPoint = z.infer<typeof containerHistoryPointSchema>;

/** The chart point for a stats sample. */
export function toContainerHistoryPoint(stats: ContainerStats): ContainerHistoryPoint {
  return { at: stats.at, cpuPercent: stats.cpuPercent, memoryUsedBytes: stats.memoryUsedBytes };
}

/** Docker not reachable (no proxy, no permission): no container data — system stats are unaffected. */
const dockerUnavailableSchema = z.object({ dockerAvailable: z.literal(false) });

/** The full container list every time — a home server has few containers. */
export const containersUpdateSchema = z.discriminatedUnion('dockerAvailable', [
  z.object({ dockerAvailable: z.literal(true), containers: z.array(containerSchema) }),
  dockerUnavailableSchema,
]);
export type ContainersUpdate = z.infer<typeof containersUpdateSchema>;

export const containersSnapshotSchema = z.discriminatedUnion('dockerAvailable', [
  z.object({
    dockerAvailable: z.literal(true),
    containers: z.array(containerSchema),
    /** Per container id, up to the last 15 minutes, oldest first. */
    history: z.record(z.string(), z.array(containerHistoryPointSchema)),
  }),
  dockerUnavailableSchema,
]);
export type ContainersSnapshot = z.infer<typeof containersSnapshotSchema>;
