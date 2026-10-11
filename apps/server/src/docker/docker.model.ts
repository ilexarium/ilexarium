import type { Container } from '@homelab/shared';

/** A container without its live stats. */
export type DockerContainer = Omit<Container, 'stats'>;

/** A container event: something about it changed (started, died, became healthy, …). */
export interface DockerContainerEvent {
  containerId: string;
  action: string;
}

/**
 * The parts of a Docker stats frame we use. Our own type: fields are optional because Docker
 * leaves some out (cgroup v1 vs v2, no networks, no block I/O accounting).
 */
export interface RawContainerStats {
  read?: string;
  cpu_stats?: CpuStats;
  precpu_stats?: CpuStats;
  memory_stats?: {
    usage?: number;
    limit?: number;
    stats?: Record<string, number>;
  };
  networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>;
  blkio_stats?: {
    io_service_bytes_recursive?: { op?: string; value?: number }[] | null;
  };
}

interface CpuStats {
  cpu_usage?: { total_usage?: number; percpu_usage?: number[] | null };
  system_cpu_usage?: number;
  online_cpus?: number;
}
