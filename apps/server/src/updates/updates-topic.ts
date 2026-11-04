import { Injectable, Logger } from '@nestjs/common';
import type { UpdatesStatus } from '@laris/shared';
import { auditTime, merge, type Observable, switchMap } from 'rxjs';
import { safely } from '../common/safely.js';
import { RealtimeSubscriptions } from '../realtime/realtime-subscriptions.js';
import type { TopicSource } from '../realtime/realtime.model.js';
import { UpdateJobs } from './update-jobs.js';
import { UPDATES_PUBLISH_MS } from './updates.constants.js';
import { UpdatesService } from './updates.service.js';

/** The `updates` topic: what's installed, what's available, a running update's progress. */
@Injectable()
export class UpdatesTopic implements TopicSource<'updates'> {
  private readonly logger = new Logger(UpdatesTopic.name);
  readonly topic = 'updates';
  readonly updates$: Observable<UpdatesStatus>;

  constructor(
    private readonly updatesService: UpdatesService,
    updateJobs: UpdateJobs,
    realtimeSubscriptions: RealtimeSubscriptions,
  ) {
    this.updates$ = merge(updatesService.changes$, updateJobs.changes$).pipe(
      auditTime(UPDATES_PUBLISH_MS),
      switchMap(() =>
        safely(
          () => this.snapshot(),
          (error) => this.logger.warn(`The updates snapshot failed: ${(error as Error).message}`),
        ),
      ),
    );
    realtimeSubscriptions.registerSource(this);
  }

  snapshot(): Promise<UpdatesStatus> {
    return this.updatesService.status();
  }
}
