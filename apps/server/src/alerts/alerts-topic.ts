import { Injectable, Logger } from '@nestjs/common';
import type { AlertsStatus } from '@laris/shared';
import { auditTime, interval, merge, type Observable, switchMap } from 'rxjs';
import { CatalogService } from '../catalog/catalog.service.js';
import { safely } from '../common/safely.js';
import { RealtimeSubscriptions } from '../realtime/realtime-subscriptions.js';
import type { TopicSource } from '../realtime/realtime.model.js';
import { AlertChannels } from './alert-channels.js';
import { AlertRecords } from './alert-records.js';
import { ALERTS_PUBLISH_MS, ALERTS_REFRESH_MS } from './alerts.constants.js';

/** The `alerts` topic: open alerts, recently closed ones, the last delivery problem. */
@Injectable()
export class AlertsTopic implements TopicSource<'alerts'> {
  private readonly logger = new Logger(AlertsTopic.name);
  readonly topic = 'alerts';
  readonly updates$: Observable<AlertsStatus>;

  constructor(
    private readonly alertRecords: AlertRecords,
    private readonly alertChannels: AlertChannels,
    private readonly catalogService: CatalogService,
    realtimeSubscriptions: RealtimeSubscriptions,
  ) {
    this.updates$ = merge(
      alertRecords.changes$,
      alertChannels.changes$,
      interval(ALERTS_REFRESH_MS),
    ).pipe(
      auditTime(ALERTS_PUBLISH_MS),
      switchMap(() =>
        safely(
          () => this.snapshot(),
          (error) => this.logger.warn(`The alerts snapshot failed: ${(error as Error).message}`),
        ),
      ),
    );
    realtimeSubscriptions.registerSource(this);
  }

  async snapshot(): Promise<AlertsStatus> {
    const [{ open, closed }, deliveryFailure] = await Promise.all([
      this.alertRecords.view((id) => this.catalogService.get(id)?.meta.name ?? null),
      this.alertChannels.deliveryFailure(),
    ]);
    return { open, closed, deliveryFailure };
  }
}
