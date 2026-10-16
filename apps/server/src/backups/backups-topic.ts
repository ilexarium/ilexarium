import { Injectable } from '@nestjs/common';
import type { BackupsStatus } from '@homelab/shared';
import {
  auditTime,
  catchError,
  EMPTY,
  from,
  interval,
  merge,
  type Subscription,
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
  private subscription: Subscription | null = null;

  constructor(
    private readonly statusReader: BackupStatusReader,
    private readonly plans: BackupPlanManager,
    private readonly runs: BackupRuns,
    private readonly progress: BackupProgressFollower,
    private readonly results: BackupResults,
    private readonly restores: BackupRestores,
    private readonly slot: OperationSlot,
    subscriptions: RealtimeSubscriptions,
  ) {
    subscriptions.registerSource(this);
  }

  snapshot(): Promise<BackupsStatus> {
    return this.statusReader.status();
  }

  start(publish: (update: BackupsStatus) => void): void {
    this.subscription = merge(
      this.plans.changes$,
      this.runs.changes$,
      this.progress.changes$,
      this.results.changes$,
      this.restores.changes$,
      this.slot.changes$,
      interval(REFRESH_MS),
    )
      .pipe(
        // The first change opens a window; at its end, one snapshot of everything.
        auditTime(BACKUPS_PUBLISH_MS),
        // A newer snapshot replaces one still being taken; a failed one waits for the next change.
        switchMap(() => from(this.snapshot()).pipe(catchError(() => EMPTY))),
      )
      .subscribe(publish);
  }

  stop(): void {
    this.subscription?.unsubscribe();
    this.subscription = null;
  }
}
