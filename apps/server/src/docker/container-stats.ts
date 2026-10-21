import type { ContainerStats } from '@laris/shared';
import type { RawContainerStats } from './docker.model.js';

/**
 * The Docker CLI's formula: the container's CPU time over the host's in the same period, times
 * the number of CPUs — so 100 % is one full core. 0 when there is no previous reading yet.
 */
export function cpuPercent(stats: RawContainerStats): number {
  const now = stats.cpu_stats;
  const before = stats.precpu_stats;
  const cpuDelta = (now?.cpu_usage?.total_usage ?? 0) - (before?.cpu_usage?.total_usage ?? 0);
  const systemDelta = (now?.system_cpu_usage ?? 0) - (before?.system_cpu_usage ?? 0);
  if (cpuDelta <= 0 || systemDelta <= 0 || !before?.system_cpu_usage) return 0;
  const cpus = now?.online_cpus || now?.cpu_usage?.percpu_usage?.length || 1;
  return (cpuDelta / systemDelta) * cpus * 100;
}

/** Usage without the page cache that can be reclaimed, like `docker stats` (cgroup v1 and v2). */
export function memoryUsedBytes(stats: RawContainerStats): number {
  const usage = stats.memory_stats?.usage ?? 0;
  const detail = stats.memory_stats?.stats ?? {};
  const inactiveFile = detail.total_inactive_file ?? detail.inactive_file; // v1 ?? v2
  return inactiveFile !== undefined && inactiveFile < usage ? usage - inactiveFile : usage;
}

/** Our shape for a stats frame; `fallbackAt` when Docker's own timestamp is missing. */
export function toContainerStats(stats: RawContainerStats, fallbackAt: number): ContainerStats {
  let netRxBytes = 0;
  let netTxBytes = 0;
  for (const network of Object.values(stats.networks ?? {})) {
    netRxBytes += network.rx_bytes ?? 0;
    netTxBytes += network.tx_bytes ?? 0;
  }
  let blockReadBytes = 0;
  let blockWriteBytes = 0;
  for (const { op, value = 0 } of stats.blkio_stats?.io_service_bytes_recursive ?? []) {
    const operation = op?.toLowerCase();
    if (operation === 'read') blockReadBytes += value;
    if (operation === 'write') blockWriteBytes += value;
  }
  const read = stats.read ? Date.parse(stats.read) : Number.NaN;
  return {
    at: Number.isFinite(read) && read > 0 ? read : fallbackAt,
    cpuPercent: cpuPercent(stats),
    memoryUsedBytes: memoryUsedBytes(stats),
    memoryLimitBytes: stats.memory_stats?.limit ?? 0,
    netRxBytes,
    netTxBytes,
    blockReadBytes,
    blockWriteBytes,
  };
}
