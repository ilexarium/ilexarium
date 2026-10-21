import type { BackupProgress, BackupStatus } from '@laris/shared';

/** The run the progress file describes, as followed: its live view, its process and its end. */
export interface FollowedRun {
  progress: BackupProgress;
  itemId: string | null;
  pid: number;
  /** Null until its `done` event. */
  finished: { status: BackupStatus; errorCode: string | null; at: string } | null;
}

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
