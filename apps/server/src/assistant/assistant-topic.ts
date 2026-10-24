import { Injectable } from '@nestjs/common';
import type { AiTopic } from '@laris/shared';
import { auditTime, map, type Observable } from 'rxjs';
import { RealtimeSubscriptions } from '../realtime/realtime-subscriptions.js';
import type { TopicSource } from '../realtime/realtime.model.js';
import { PULL_PUBLISH_MS } from './assistant.constants.js';
import { ModelPulls } from './model-pulls.js';

/** The `assistant` topic: the current or last model download, while the Models page is open. */
@Injectable()
export class AssistantTopic implements TopicSource<'assistant'> {
  readonly topic = 'assistant';
  readonly updates$: Observable<AiTopic>;

  constructor(
    private readonly modelPulls: ModelPulls,
    subscriptions: RealtimeSubscriptions,
  ) {
    this.updates$ = modelPulls.changes$.pipe(
      auditTime(PULL_PUBLISH_MS),
      map(() => ({ pull: this.modelPulls.view() })),
    );
    subscriptions.registerSource(this);
  }

  snapshot(): Promise<AiTopic> {
    return Promise.resolve({ pull: this.modelPulls.view() });
  }
}
