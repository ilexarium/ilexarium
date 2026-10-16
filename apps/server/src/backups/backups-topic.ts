import { Injectable } from '@nestjs/common';
import type { BackupsStatus } from '@homelab/shared';
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
import { OperationSlot } from '../jobs/operation-slot.js';
import { RealtimeSubscriptions } from '../realtime/realtime-subscriptions.js';
import type { TopicSource } from '../realtime/realtime.model.js';
import { BackupPlanManager } from './backup-plan-manager.js';
import { BackupProgressFollower } from './backup-progress.js';
import { BackupRestores } from './backup-restores.js';
import { BackupResults } from './backup-results.js';
import { BackupRuns } from './backup-runs.js';
import { BackupStatusReader } from './backup-status-reader.js';

/** Changes come in bursts (progress lines, restore output): at most one update this often. */
export const BACKUPS_PUBLISH_MS = 500;
/** Also now and then without a change: "last backed up" ages, the disk fills. */
const REFRESH_MS = 60_000;

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
    private readonly statusReader: BackupStatusReader,
    plans: BackupPlanManager,
    runs: BackupRuns,
    progress: BackupProgressFollower,
    results: BackupResults,
    restores: BackupRestores,
    slot: OperationSlot,
    subscriptions: RealtimeSubscriptions,
  ) {
    this.updates$ = merge(
      plans.changes$,
      runs.changes$,
      progress.changes$,
      results.changes$,
      restores.changes$,
      slot.changes$,
      interval(REFRESH_MS),
    ).pipe(
      // The first change opens a window; at its end, one snapshot of everything.
      auditTime(BACKUPS_PUBLISH_MS),
      // A newer snapshot replaces one still being taken; a failed one waits for the next change.
      switchMap(() => from(this.snapshot()).pipe(catchError(() => EMPTY))),
    );
    subscriptions.registerSource(this);
  }

  snapshot(): Promise<BackupsStatus> {
    return this.statusReader.status();
  }
}
