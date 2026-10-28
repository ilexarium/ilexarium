import { Injectable } from '@nestjs/common';
import type { BackupsStatus } from '@laris/shared';
import {
  auditTime,
  catchError,
  EMPTY,
  from,
  interval,
  merge,
  type Observable,
  switchMap,
} from 'rxjs';
import { ChangesUnderway } from '../jobs/changes-underway.js';
import { RealtimeSubscriptions } from '../realtime/realtime-subscriptions.js';
import type { TopicSource } from '../realtime/realtime.model.js';
import { BackupPlanManager } from './backup-plan-manager.js';
import { BackupProgressFollower } from './backup-progress.js';
import { BackupRestores } from './backup-restores.js';
import { BackupResults } from './backup-results.js';
import { BackupRuns } from './backup-runs.js';
import { BackupStatusReader } from './backup-status-reader.js';
import { BACKUPS_PUBLISH_MS, BACKUPS_REFRESH_MS } from './backups.constants.js';

/**
 * The `backups` topic: the plan's status and warnings, the running run's live progress (scheduled
 * or manual, from the wrapper's progress file), the last results, the latest restore.
 */
@Injectable()
export class BackupsTopic implements TopicSource<'backups'> {
  readonly topic = 'backups';

  /** While subscribed: at most one snapshot every 500 ms, after any change, and now and then. */
  readonly updates$: Observable<BackupsStatus>;

  constructor(
    private readonly backupStatusReader: BackupStatusReader,
    backupPlanManager: BackupPlanManager,
    backupRuns: BackupRuns,
    backupProgressFollower: BackupProgressFollower,
    backupResults: BackupResults,
    backupRestores: BackupRestores,
    changesUnderway: ChangesUnderway,
    realtimeSubscriptions: RealtimeSubscriptions,
  ) {
    this.updates$ = merge(
      backupPlanManager.changes$,
      backupRuns.changes$,
      backupProgressFollower.changes$,
      backupResults.changes$,
      backupRestores.changes$,
      changesUnderway.changes$,
      interval(BACKUPS_REFRESH_MS),
    ).pipe(
      // The first change opens a window; at its end, one snapshot of everything.
      auditTime(BACKUPS_PUBLISH_MS),
      // A newer snapshot replaces one still being taken; a failed one waits for the next change.
      switchMap(() => from(this.snapshot()).pipe(catchError(() => EMPTY))),
    );
    realtimeSubscriptions.registerSource(this);
  }

  snapshot(): Promise<BackupsStatus> {
    return this.backupStatusReader.status();
  }
}
