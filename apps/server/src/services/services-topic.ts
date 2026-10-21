import { Injectable } from '@nestjs/common';
import type { ServicesList } from '@laris/shared';
import { auditTime, catchError, EMPTY, from, type Observable, switchMap } from 'rxjs';
import { RealtimeSubscriptions } from '../realtime/realtime-subscriptions.js';
import type { TopicSource } from '../realtime/realtime.model.js';
import { ServiceJobs } from './service-jobs.js';
import { ServiceManager } from './service-manager.js';

/** Changes come in bursts (every output line): at most one update this often. */
export const SERVICES_PUBLISH_MS = 250;

/** The `services` topic: installed services and their running job, pushed on every change. */
@Injectable()
export class ServicesTopic implements TopicSource<'services'> {
  readonly topic = 'services';

  /** While subscribed: at most one list every 250 ms, after any change of a job. */
  readonly updates$: Observable<ServicesList>;

  constructor(
    private readonly services: ServiceManager,
    jobs: ServiceJobs,
    subscriptions: RealtimeSubscriptions,
  ) {
    this.updates$ = jobs.changes$.pipe(
      auditTime(SERVICES_PUBLISH_MS),
      switchMap(() => from(this.snapshot()).pipe(catchError(() => EMPTY))),
    );
    subscriptions.registerSource(this);
  }

  async snapshot(): Promise<ServicesList> {
    return { services: await this.services.list() };
  }
}
