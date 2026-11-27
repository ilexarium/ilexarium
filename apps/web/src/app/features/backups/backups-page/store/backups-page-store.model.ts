import type {
  BackupArchive,
  BackupRecovery,
  BackupRecoveryCheckResponse,
  BackupDestination,
  BackupFoldersResponse,
  BackupPlan,
  BackupRestore,
  BackupRun,
} from '@ilex/shared';
import type { BackupsTab } from '../../backups.model';

export interface BackupsCoreState {
  /** Null while loading (`loaded` false) or before setup. */
  plan: BackupPlan | null;
  loaded: boolean;
  failed: boolean;
  runs: BackupRun[] | null;
  restores: BackupRestore[] | null;
  /** Actions waiting for the server, for pending buttons (`run`, `run:<item>`, `remove:<item>`…). */
  pending: string[];
  /** The open tab (the page keeps it in the URL). */
  tab: BackupsTab;
  /** The item whose side sheet is open. */
  sheetItemId: string | null;
}

export interface BackupPlanState {
  destinations: BackupDestination[] | null;
  /** The passphrase while it's shown (after setup, or "Show again"); never kept longer. */
  passphrase: string | null;
  /** Shown right after setup (the stronger wording). */
  passphraseFirst: boolean;
}

export interface BackupHistoryState {
  /** Output of runs opened in the history, by run id. */
  outputs: Record<string, string[]>;
}

export interface BackupRestoresState {
  /** The archives of the item a restore dialog is open for. */
  archives: { itemId: string; list: BackupArchive[] | null } | null;
}

export interface FolderPickerState {
  /** The folder picker's current place. */
  folders: BackupFoldersResponse | null;
}

/** Restoring Ilexarium from the backup disk: the dialog's steps. */
export type RecoveryStep = 'idle' | 'finding' | 'checking' | 'starting' | 'waiting' | 'failed';

export interface BackupRecoveryState {
  /** The last recovery here (its notice), or null. */
  recovery: BackupRecovery | null;
  /** The backups found on mounted disks, and once the passphrase opened one, its newest. */
  recoveryFound: BackupRecoveryCheckResponse | null;
  recoveryStep: RecoveryStep;
  /** Why the last step failed, in words. */
  recoveryError: string | null;
}
