import type { Container } from '@laris/shared';

/** A container without its live stats. */
export type DockerContainer = Omit<Container, 'stats'>;

/**
 * Why a container action failed: no such container; Docker answered with an error; Docker
 * couldn't be reached (or didn't answer in time — the action may still have happened).
 */
export type ContainerActionFailure = 'not_found' | 'failed' | 'unavailable';

/**
 * A container event: something about it changed (started, died, became healthy, …). `action` is
 * Docker's, e.g. `die` or `health_status: unhealthy`. Only these attributes are kept (Docker sends
 * every label).
 */
export interface DockerContainerEvent {
  containerId: string;
  action: string;
  /** The container's name, without Docker's leading `/`; null if Docker left it out. */
  name: string | null;
  composeProject: string | null;
  protected: boolean;
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
