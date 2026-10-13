import { Injectable } from '@nestjs/common';
import type { ServicesList } from '@homelab/shared';
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
  private unsubscribe: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly services: ServiceManager,
    private readonly jobs: ServiceJobs,
    subscriptions: RealtimeSubscriptions,
  ) {
    subscriptions.registerSource(this);
  }

  async snapshot(): Promise<ServicesList> {
    return { services: await this.services.list() };
  }

  start(publish: (update: ServicesList) => void): void {
    this.unsubscribe = this.jobs.onChange(() => {
      this.timer ??= setTimeout(() => {
        this.timer = null;
        void this.snapshot().then(publish, () => undefined);
      }, SERVICES_PUBLISH_MS);
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
