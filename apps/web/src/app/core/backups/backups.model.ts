import type { BackupMode } from '@ilex/shared';

/** How an app is backed up, and the subfolders skipped (relative to its folder). */
export interface BackupPreset {
  mode: BackupMode;
  skip: string[];
}
