import type {
  BackupHistoryState,
  BackupPlanState,
  BackupRestoresState,
  BackupsCoreState,
  FolderPickerState,
} from './backups-page-store.model';

export const initialBackupsCoreState: BackupsCoreState = {
  plan: null,
  loaded: false,
  failed: false,
  runs: null,
  restores: null,
  pending: [],
  tab: 'items',
  sheetItemId: null,
};

export const initialBackupPlanState: BackupPlanState = {
  destinations: null,
  passphrase: null,
  passphraseFirst: false,
};

export const initialBackupHistoryState: BackupHistoryState = { outputs: {} };

export const initialBackupRestoresState: BackupRestoresState = { archives: null };

export const initialFolderPickerState: FolderPickerState = { folders: null };
