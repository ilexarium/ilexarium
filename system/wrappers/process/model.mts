// process/model.mts — REVIEW-REQUIRED (system/CLAUDE.md): runs as root.
//
// The shapes this program works with.

export interface Config {
  process: {
    /** The app's own user: its processes are never signalled. Required in root mode. */
    appUid?: number;
    /** People's accounts start here (default 1000); they end at 60000. */
    minUid?: number;
    /** Development only: a pretend /proc (in root mode always /proc). */
    dev?: { procRoot: string };
  };
}

/** The request, checked. */
export interface SignalRequest {
  pid: number;
  startTicks: string;
  signal: 'TERM' | 'KILL';
}

/** A process as this program reads it from /proc/<pid>. */
export interface ProcessInfo {
  startTicks: string;
  /** PF_* flags (PF_KTHREAD: a kernel thread). */
  flags: number;
  /** Real, effective, saved and file-system uid. */
  uids: number[];
  /** In a container (by its cgroup). */
  inContainer: boolean;
}
