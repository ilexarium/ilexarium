import { Injectable } from '@nestjs/common';
import type { ServicesList } from '@laris/shared';
import { auditTime, catchError, EMPTY, from, type Observable, switchMap } from 'rxjs';
import { RealtimeSubscriptions } from '../realtime/realtime-subscriptions.js';
import type { TopicSource } from '../realtime/realtime.model.js';
import { ServiceJobs } from './service-jobs.js';
import { ServiceManager } from './service-manager.js';
import { SERVICES_PUBLISH_MS } from './services.constants.js';

/** The `services` topic: installed services and their running job, pushed on every change. */
@Injectable()
export class ServicesTopic implements TopicSource<'services'> {
  readonly topic = 'services';

  readonly updates$: Observable<ServicesList>;

  constructor(
    private readonly serviceManager: ServiceManager,
    serviceJobs: ServiceJobs,
    subscriptions: RealtimeSubscriptions,
  ) {
    this.updates$ = serviceJobs.changes$.pipe(
      auditTime(SERVICES_PUBLISH_MS),
      switchMap(() => from(this.snapshot()).pipe(catchError(() => EMPTY))),
    );
    subscriptions.registerSource(this);
  }

  async snapshot(): Promise<ServicesList> {
    return { services: await this.serviceManager.list() };
  }
}
