/** Cumulative CPU time since boot, in clock ticks, across all cores. */
export interface CpuTimes {
  idle: number;
  total: number;
}

/** `/proc/pressure/<resource>`: the share of the last minute some processes waited, 0–100. */
export interface Pressure {
  cpu: number;
  memory: number;
  io: number;
}

export interface MemoryInfo {
  totalBytes: number;
  availableBytes: number;
  swapTotalBytes: number;
  swapFreeBytes: number;
}

/** Cumulative bytes since the interface came up. */
export interface NetCounters {
  rxBytes: number;
  txBytes: number;
}

export interface Mount {
  device: string;
  mount: string;
  fsType: string;
}

/** A mount point from /proc/self/mountinfo. */
export interface MountPoint {
  mount: string;
  fsType: string;
  /** `major:minor` of the mounted device. */
  device: string;
  source: string;
}

/** A file system's size and the space a normal user may still use. */
export interface Space {
  totalBytes: number;
  freeBytes: number;
}

/** A folder inside another, for the folder picker. */
export interface Subfolder {
  name: string;
  path: string;
}

/** What is at a path: a folder, something else, nothing — or the app may not look (another user's). */
export type FolderState = 'folder' | 'other' | 'missing' | 'unreadable';

/** A block device from /sys/class/block (a disk or a partition), with what udev knows of it. */
export interface BlockDevice {
  name: string;
  /** `major:minor`. */
  number: string;
  partition: boolean;
  /** The disk it's on (itself for a disk). */
  disk: string;
  /** A disk's partitions, in order (empty for a partition). */
  partitions: string[];
  holders: string[];
  slaves: string[];
  sizeBytes: number;
  removable: boolean;
  model: string | null;
  fsType: string | null;
  uuid: string | null;
  label: string | null;
}

/** One process as /proc shows it (proc(5)), before CPU shares and names are worked out. */
export interface ProcStat {
  pid: number;
  /** `comm`: the kernel's short name (at most 15 characters; may hold spaces and parentheses). */
  name: string;
  /** The state letter: R, S, D, Z, T, t, I, … */
  state: string;
  /** PF_* flags; PF_KTHREAD marks a kernel thread. */
  flags: number;
  /** User plus system CPU time, in clock ticks. */
  cpuTicks: number;
  priority: number;
  nice: number;
  virtualBytes: number;
  /** Since boot, in clock ticks, as digits (with the PID it names one process). */
  startTicks: string;
}

/** A process: its /proc/<pid>/stat, status, cmdline and cgroup together. */
export interface RawProcess extends ProcStat {
  /** Real, effective, saved and file-system uid. */
  uids: [number, number, number, number];
  rssBytes: number;
  /** Resident file pages and shared memory (htop's SHR). */
  sharedBytes: number;
  command: string;
  /** The container's ID (64 hex digits) if it runs in one; `''` in one whose ID isn't known. */
  containerId: string | null;
}

/** One temperature input of a hwmon chip or a thermal zone. */
export interface TemperatureSensor {
  /** The hwmon chip's `name`, or the thermal zone's `type`. */
  chip: string;
  label: string | null;
  celsius: number;
  criticalCelsius: number | null;
}
