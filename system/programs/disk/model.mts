// disk/model.mts — REVIEW-REQUIRED (system/CLAUDE.md): runs as root.
//
// The shapes this program works with.

export interface Config {
  disk: {
    /** Required in root mode. In development without it, mounts are only pretended. */
    systemctlBin?: string;
    /** Development only: a pretend host (sys, run/udev, dev, proc), mount root, unit folder. */
    dev?: { root: string; mountRoot: string; unitDir: string; backupPlan: string };
  };
}

export interface Paths {
  /** `/` on the host; in development the pretend host's root. */
  host: string;
  mountRoot: string;
  unitDir: string;
  backupPlan: string;
  lock: string;
}

/** A block device as this program reads it from /sys and the udev database. */
export interface Device {
  name: string;
  /** `major:minor`. */
  number: string;
  /** The whole disk it's on (itself for a disk). */
  disk: string;
  partition: boolean;
  /** Partitions of a disk (empty for a partition). */
  partitions: string[];
  holders: string[];
  slaves: string[];
  fsType: string | null;
  uuid: string | null;
}

export interface Mount {
  number: string;
  point: string;
  source: string;
}
