import { Injectable } from '@nestjs/common';
import { join } from 'node:path';
import type { DisksStatus } from '@laris/shared';
import {
  auditTime,
  catchError,
  distinctUntilChanged,
  EMPTY,
  from,
  interval,
  merge,
  type Observable,
  switchMap,
} from 'rxjs';
import { watchFolder } from '../common/watch-folder.js';
import { ChangesUnderway } from '../jobs/changes-underway.js';
import { RealtimeSubscriptions } from '../realtime/realtime-subscriptions.js';
import type { TopicSource } from '../realtime/realtime.model.js';
import { DiskManager } from './disk-manager.js';
import { DISKS_POLL_MS, DISKS_PUBLISH_MS } from './disks.constants.js';

/**
 * The `disks` topic: the disks and their partitions — a disk plugged in appears at once (a watch
 * on /dev/disk/by-uuid), mounts and unmounts as they happen. Sent only when something changed.
 */
@Injectable()
export class DisksTopic implements TopicSource<'disks'> {
  readonly topic = 'disks';
  readonly updates$: Observable<DisksStatus>;

  constructor(
    private readonly diskManager: DiskManager,
    changesUnderway: ChangesUnderway,
    realtimeSubscriptions: RealtimeSubscriptions,
  ) {
    this.updates$ = merge(
      watchFolder(() => join(diskManager.places.host, 'dev/disk/by-uuid'), DISKS_POLL_MS),
      interval(DISKS_POLL_MS),
      diskManager.changes$,
      changesUnderway.changes$,
    ).pipe(
      auditTime(DISKS_PUBLISH_MS),
      switchMap(() => from(this.snapshot()).pipe(catchError(() => EMPTY))),
      distinctUntilChanged((a, b) => JSON.stringify(a) === JSON.stringify(b)),
    );
    realtimeSubscriptions.registerSource(this);
  }

  snapshot(): Promise<DisksStatus> {
    return this.diskManager.status();
  }
}
