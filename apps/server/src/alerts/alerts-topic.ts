import { Injectable } from '@nestjs/common';
import type { AlertsStatus } from '@homelab/shared';
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
import { RealtimeSubscriptions } from '../realtime/realtime-subscriptions.js';
import type { TopicSource } from '../realtime/realtime.model.js';
import { AlertChannels } from './alert-channels.js';
import { AlertRecords } from './alert-records.js';

/** Changes come in bursts (a disk's alerts, a backup's): at most one update this often. */
export const ALERTS_PUBLISH_MS = 300;
/** Also now and then: closed alerts age out of the list. */
const REFRESH_MS = 60_000;

/** The `alerts` topic: open alerts, recently closed ones, the last delivery problem. */
@Injectable()
export class AlertsTopic implements TopicSource<'alerts'> {
  readonly topic = 'alerts';
  readonly updates$: Observable<AlertsStatus>;

  constructor(
    private readonly records: AlertRecords,
    private readonly channels: AlertChannels,
    subscriptions: RealtimeSubscriptions,
  ) {
    this.updates$ = merge(records.changes$, channels.changes$, interval(REFRESH_MS)).pipe(
      auditTime(ALERTS_PUBLISH_MS),
      switchMap(() => from(this.snapshot()).pipe(catchError(() => EMPTY))),
    );
    subscriptions.registerSource(this);
  }

  async snapshot(): Promise<AlertsStatus> {
    const [{ open, closed }, deliveryFailure] = await Promise.all([
      this.records.view(),
      this.channels.deliveryFailure(),
    ]);
    return { open, closed, deliveryFailure };
  }
}
