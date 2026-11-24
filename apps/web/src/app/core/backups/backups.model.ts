import type { BackupMode, BackupRestore, BackupRun } from '@ilex/shared';

/** How an app is backed up, and the subfolders skipped (relative to its folder). */
export interface BackupPreset {
  mode: BackupMode;
  skip: string[];
}

/** The Backups page's history: runs and restores, read together. */
export interface BackupHistory {
  runs: BackupRun[];
  restores: BackupRestore[];
}
