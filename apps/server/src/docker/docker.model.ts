import type { Container, UnusedImage } from '@ilex/shared';

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

/** Unused images and the build cache, with what removing them frees. */
export interface DockerDiskUsage {
  images: UnusedImage[];
  imagesBytes: number;
  buildCacheBytes: number;
}

/** A volume no container uses. */
export interface DockerVolume {
  name: string;
  composeProject: string | null;
  anonymous: boolean;
  created: string | null;
}

/** What a prune removed: the bytes Docker says it freed and the IDs it deleted. */
export interface DockerPruned {
  bytesFreed: number;
  deleted: string[];
}

/** Why freeing space failed: as `ContainerActionFailure`, and a volume a container uses. */
export type CleanupFailure = 'not_found' | 'in_use' | 'failed' | 'unavailable';

/** The parts of `GET /system/df` we use; Docker leaves sections out that weren't asked for. */
export interface RawDiskUsage {
  Images?: {
    Id: string;
    RepoTags?: string[] | null;
    Created?: number;
    Size?: number;
    /** -1 when Docker didn't work it out. */
    SharedSize?: number;
    /** -1 when Docker didn't count. */
    Containers?: number;
  }[];
  ImageUsage?: { Reclaimable?: number };
  BuildCache?: { InUse?: boolean; Shared?: boolean; Size?: number }[] | null;
  BuildCacheUsage?: { Reclaimable?: number };
  Volumes?: { Name: string; UsageData?: { Size?: number } | null }[];
}
