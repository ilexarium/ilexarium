import type { BackupProgress, BackupRestorePhase } from '@ilex/shared';
import type { JobDone, JobStart } from './backup-jobs.constants.js';

/** A job as its file tells it so far. */
export interface Job {
  id: string;
  /** Null: not started (yet), or not this file's job. */
  start: JobStart | null;
  /** A run's live view. */
  progress: BackupProgress | null;
  /** A restore's phase. */
  phase: BackupRestorePhase | null;
  output: string[];
  done: JobDone | null;
}
