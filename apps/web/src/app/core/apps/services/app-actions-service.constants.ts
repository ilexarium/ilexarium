import type { BackupPreset } from '../../backups/backups.model';

/** An app without a template's preset: stopped while it's backed up, nothing skipped. */
export const DEFAULT_BACKUP_PRESET: BackupPreset = { mode: 'stop', skip: [] };
