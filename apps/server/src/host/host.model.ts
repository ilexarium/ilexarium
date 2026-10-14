/** Cumulative CPU time since boot, in clock ticks, across all cores. */
export interface CpuTimes {
  idle: number;
  total: number;
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
