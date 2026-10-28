// backup/model.mts — REVIEW-REQUIRED (system/CLAUDE.md): runs as root.
//
// The backup wrapper's types (erasable syntax only: Node strips them before running).

export interface Config {
  protectedPaths: string[];
  dockerBin: string;
  lockFile?: string;
  home?: string;
  backup: BackupConfig;
}

export interface BackupConfig {
  borgBin: string;
  /** Without it (development), the timer isn't touched. */
  systemctlBin?: string;
  /** The app's user and group: its group may read the progress and results files; neither may write above the repository. */
  appUid?: number;
  appGid?: number;
  /** The platform item: its database (dumped inside its container) and its files. */
  platform: { container: string; database: string; user: string; files: string[] };
  /** Development only (not root): where the root-only files go, and test knobs. */
  dev?: {
    dir: string;
    destinationRoots: string[];
    mountInfo: string;
    lockWaitMs?: number;
    retryDelayMs?: number;
  };
}

export interface Paths {
  plan: string;
  repository: string;
  passphrase: string;
  state: string;
  timerDropIn: string;
  mountInfo: string;
  lock: string;
  /** Development: the pretend disks' folders; root mode: null (any disk that isn't a system disk). */
  destinationRoots: string[] | null;
  lockWaitMs: number;
  retryDelayMs: number;
}

export type ItemKind = 'platform' | 'app' | 'folder';

export interface PlanItem {
  id: string;
  kind: ItemKind;
  /** app: its Compose project (stopped and started by name), its folders, skips and mode. */
  project?: string;
  folders?: string[];
  skip?: string[];
  mode?: 'live' | 'stop';
  /** folder */
  path?: string;
  /** Not backed up any more; kept so its archives can be restored or forgotten. */
  removed?: boolean;
}

export interface Plan {
  destination: string;
  schedule: { frequency: 'daily' | 'every12h' | 'every6h'; time: string };
  retention: { daily: number; weekly: number; monthly: number };
  items: PlanItem[];
}

export interface BorgLog {
  level: string;
  message: string;
  msgid: string;
}

export interface ItemResult {
  itemId: string;
  status: 'ok' | 'warning' | 'failed';
  errorCode: string | null;
  archive: string | null;
  originalBytes: number | null;
  addedBytes: number | null;
  warnings: string[];
  /** The archives it has after pruning — the app keeps this list (no listing action). */
  archives: string[] | null;
}

export interface Repository {
  path: string;
  id: string;
}

export interface Ran {
  code: number;
  stdout: string;
  logs: BorgLog[];
}

/** A folder a restore in place moved aside: `discard` deletes only what's listed. */
export interface SetAside {
  path: string;
  restoreId: string;
}
