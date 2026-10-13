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

/** What is at a path: a folder, something else, nothing — or the app may not look (another user's). */
export type FolderState = 'folder' | 'other' | 'missing' | 'unreadable';
