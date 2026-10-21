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
import { OperationSlot } from '../jobs/operation-slot.js';
import { RealtimeSubscriptions } from '../realtime/realtime-subscriptions.js';
import type { TopicSource } from '../realtime/realtime.model.js';
import { DiskManager } from './disk-manager.js';

/** Changes come in bursts (a disk's partitions appear one by one): at most one update this often. */
export const DISKS_PUBLISH_MS = 300;
/** Looked at again this often anyway (mounts made outside the app, a missed notice). */
export const DISKS_POLL_MS = 5_000;

/**
 * The `disks` topic: the disks and their partitions — a disk plugged in appears at once (a watch
 * on /dev/disk/by-uuid), mounts and unmounts as they happen. Sent only when something changed.
 */
@Injectable()
export class DisksTopic implements TopicSource<'disks'> {
  readonly topic = 'disks';
  readonly updates$: Observable<DisksStatus>;

  constructor(
    private readonly disks: DiskManager,
    slot: OperationSlot,
    subscriptions: RealtimeSubscriptions,
  ) {
    this.updates$ = merge(
      watchFolder(() => join(disks.places.host, 'dev/disk/by-uuid'), DISKS_POLL_MS),
      interval(DISKS_POLL_MS),
      disks.changes$,
      slot.changes$,
    ).pipe(
      auditTime(DISKS_PUBLISH_MS),
      switchMap(() => from(this.snapshot()).pipe(catchError(() => EMPTY))),
      distinctUntilChanged((a, b) => JSON.stringify(a) === JSON.stringify(b)),
    );
    subscriptions.registerSource(this);
  }

  snapshot(): Promise<DisksStatus> {
    return this.disks.status();
  }
}
