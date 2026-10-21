import type { DiskPartition } from '@laris/shared';

/** A partition the mount dialog is open for, with the disk it's on (for its name). */
export interface MountTarget {
  partition: DiskPartition;
  /** What the disk is called on the page (its model, or its device). */
  diskName: string;
}

/** A disk mounted here, to unmount — or to forget when it isn't connected. */
export interface UnmountTarget {
  name: string;
  mountPoint: string;
  connected: boolean;
}
