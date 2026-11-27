import type {
  BackupHistoryState,
  BackupPlanState,
  BackupRecoveryState,
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

export const initialBackupRecoveryState: BackupRecoveryState = {
  recovery: null,
  recoveryNewest: null,
  recoveryStep: 'idle',
  recoveryError: null,
};

/** While Ilexarium restarts after a recovery: how often to look, and for how long at most. */
export const RECOVERY_POLL_MS = 3_000;
export const RECOVERY_WAIT_MS = 20 * 60_000;
