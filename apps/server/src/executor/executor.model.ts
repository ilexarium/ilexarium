import type {
  BackupErrorCode,
  DiskErrorCode,
  BackupRestoreTarget,
  BackupRetention,
  BackupSchedule,
  FieldValues,
  JobPhase,
  PublicUser,
  ServiceErrorCode,
} from '@homelab/shared';
import type { Prisma } from '../generated/prisma/client.js';

/** The deploy wrapper's config file (the same file the wrapper reads, as root, in production). */
export interface WrapperConfig {
  catalogDir: string;
  storageRoots: string[];
  serviceRoot: string;
  reservedPorts: number[];
  protectedPaths: string[];
  dockerBin: string;
  lockFile?: string;
  home?: string;
  /** The backup wrapper's part; missing until the installer (or development) adds it. */
  backup?: WrapperBackupConfig;
  /** The disk wrapper's part; missing until the installer (or development) adds it. */
  disk?: WrapperDiskConfig;
}

export interface WrapperDiskConfig {
  systemctlBin?: string;
  /** Development only: a pretend host (sys, run/udev, dev, proc), the mount root, the unit folder. */
  dev?: { root: string; mountRoot: string; unitDir: string; backupPlan: string };
}

export interface WrapperBackupConfig {
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

/** Who asked, for the audit log. */
export interface ExecutorActor {
  user: PublicUser;
  ip?: string;
}

export interface ComposeRequest {
  catalogId: string;
  serviceId: string;
  /** `up` only: every value the wrapper gets — secrets decrypted. Goes on stdin, nowhere else. */
  values?: FieldValues;
  /** Replaced by •••• in every output line. */
  secrets: readonly string[];
  /** The entry's field keys: an `@@error field=` must be one of them. */
  fields: readonly string[];
  actor: ExecutorActor;
  /** Extra audit details — never secrets (the audit log refuses secret-like keys anyway). */
  audit: Record<string, Prisma.InputJsonValue>;
  onPhase: (phase: JobPhase) => void;
  onOutput: (line: string) => void;
}

export type ComposeOutcome =
  { ok: true } | { ok: false; code: ServiceErrorCode; field: string | null };

// Backups (the backup wrapper, docs/plans/backups.md).

/** The plan as the backup wrapper's `configure` takes it (it checks all of it again). */
export interface WrapperBackupPlan {
  destination: string;
  schedule: BackupSchedule;
  retention: BackupRetention;
  items: WrapperBackupItem[];
}

export type WrapperBackupItem =
  | { id: string; kind: 'platform' }
  | {
      id: string;
      kind: 'service';
      catalogId: string;
      /** Folder field → folder: only the recipe's backup folders the user kept on. */
      folders: Record<string, string>;
      removed?: boolean;
    }
  | { id: string; kind: 'folder'; path: string; removed?: boolean };

export interface BackupRestoreInput {
  restoreId: string;
  itemId: string;
  archive: string;
  target: BackupRestoreTarget;
}

/** Progress of a call that is a job (a restore). */
export interface JobCallbacks {
  onPhase: (phase: JobPhase) => void;
  onOutput: (line: string) => void;
}

/** A backup wrapper call's outcome: its result (`@@result`), or why it failed — with a result it still printed. */
export type BackupOutcome<T> =
  { ok: true; result: T } | { ok: false; code: BackupErrorCode; result: T | null };

export type DiskOutcome<T> = { ok: true; result: T } | { ok: false; code: DiskErrorCode };
