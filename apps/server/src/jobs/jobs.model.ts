import type { JobKind, JobStatus } from '@laris/shared';

/**
 * What holds the one slot for privileged operations: a job (install, removal, restore), a backup
 * run (manual, or a scheduled one the app only follows), a short backup task (setting up the
 * repository, deleting archives or a set-aside folder), or mounting or unmounting a disk.
 */
export type OperationKind = JobKind | 'backup' | 'backupTask' | 'disk';

/** A job's saved row, whichever table it's in (service jobs, restores). */
export interface JobRow {
  id: string;
  kind: JobKind;
  status: JobStatus;
  phase: string | null;
  errorCode: string | null;
  errorField: string | null;
  output: string;
  startedAt: Date;
  finishedAt: Date | null;
}
