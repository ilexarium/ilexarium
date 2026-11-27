import type {
  BackupErrorCode,
  BackupMode,
  BackupRetention,
  BackupSchedule,
  DiskErrorCode,
  PublicUser,
  UpdateErrorCode,
} from '@ilex/shared';

/** The root programs' config file (the same one they read, as root, in production). */
export interface ProgramConfig {
  protectedPaths: string[];
  dockerBin: string;
  lockFile?: string;
  home?: string;
  /** The backup program's part; missing until the installer (or development) adds it. */
  backup?: ProgramBackupConfig;
  /** The disk program's part; missing until the installer (or development) adds it. */
  disk?: ProgramDiskConfig;
  /** The update program's part: the app's group (production); a pretend machine (development). */
  update?: ProgramUpdateConfig;
}

export interface ProgramUpdateConfig {
  appGid?: number;
  dev?: { root: string; bin: string; healthUrl: string };
}

export interface ProgramDiskConfig {
  systemctlBin?: string;
  /** Development only: a pretend host (sys, run/udev, dev, proc), the mount root, the unit folder. */
  dev?: { root: string; mountRoot: string; unitDir: string; backupPlan: string };
}

export interface ProgramBackupConfig {
  borgBin: string;
  systemctlBin?: string;
  appUid?: number;
  appGid?: number;
  platform: { container: string; database: string; user: string; files: string[] };
  /** Development only: where the root-only files go, the "disks" and their mount table. */
  dev?: {
    dir: string;
    destinationRoots: string[];
    mountInfo: string;
    lockWaitMs?: number;
    retryDelayMs?: number;
  };
}

/** `recover-check`: the backups of Ilexarium in the chosen repository, oldest first. */
export interface ProgramRecoverCheck {
  archives: { name: string; time: string }[];
}

/** Who asks, and through whose Linux session (whose sudo). */
export interface RootActor {
  user: PublicUser;
  ip?: string;
  appSessionId: string;
}

// Backups (ilex-backup).

/** The plan as `configure` takes it (it checks all of it again). */
export interface ProgramBackupPlan {
  destination: string;
  schedule: BackupSchedule;
  retention: BackupRetention;
  items: ProgramBackupItem[];
}

export type ProgramBackupItem =
  | { id: string; kind: 'platform' }
  | {
      id: string;
      kind: 'app';
      /** Its Compose project: stopped and started by name around a `stop` backup. */
      project: string;
      folders: string[];
      skip: string[];
      mode: BackupMode;
      removed?: boolean;
    }
  | { id: string; kind: 'folder'; path: string; skip: string[]; removed?: boolean };

export interface ProgramRestoreInput {
  restoreId: string;
  itemId: string;
  archive: string;
  /** Null: back where it was; else a new folder (missing or empty). */
  target: string | null;
}

/** A call's outcome: its result (`@@result`), or why it failed — with a result it still printed. */
export type BackupOutcome<T> =
  { ok: true; result: T } | { ok: false; code: BackupErrorCode; result: T | null };

export type DiskOutcome<T> = { ok: true; result: T } | { ok: false; code: DiskErrorCode };
export type UpdateStartOutcome = { ok: true } | { ok: false; code: UpdateErrorCode };

/** How a program's run is read: its `@@error` codes and the codes for the cases every run has. */
export interface ProgramKind<Code extends string> {
  name: 'backup' | 'disk' | 'update';
  codes: Record<string, Code>;
  /** It ran and failed without saying why. */
  failed: Code;
  /** It didn't run, or said something unknown: a setup problem, never "success". */
  unavailable: Code;
  timedOut: Code;
}
