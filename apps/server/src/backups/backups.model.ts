import type { BackupMode, BackupStatus } from '@ilex/shared';

/** What the warnings shown across the app are worked out from (`backupWarnings`). */
export interface WarningInput {
  now: Date;
  planCreatedAt: Date;
  /** Active items: when each was last backed up, and its latest outcome. */
  items: { lastSuccessAt: Date | null; lastErrorCode: string | null }[];
  lastRun: { status: string } | null;
  lastCheck: { status: BackupStatus; errorCode: string | null } | null;
  destination: { mounted: boolean; totalBytes: number; freeBytes: number } | null;
}

/** A checked new item, ready to be saved. */
export type NewItemRow =
  | {
      id: string;
      kind: 'app';
      project: string;
      folders: string[];
      skip: string[];
      mode: BackupMode;
    }
  | { id: string; kind: 'folder'; path: string; skip: string[] };
