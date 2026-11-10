import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { RealtimeTopic, ServerMessage } from '@ilex/shared';
import { retry, type Subscription, timer } from 'rxjs';
import { sendMessage } from './realtime-messages.js';
import { SOURCE_RETRY_MS } from './realtime.constants.js';
import type { RealtimeClient, TopicSource, UpdateData } from './realtime.model.js';

/**
 * Who is subscribed to which topic, and the only place topic sources are started and stopped:
 * nobody subscribed, nothing collected. A subscriber gets updates only after its snapshot.
 */
@Injectable()
export class RealtimeSubscriptions implements OnModuleDestroy {
  private readonly logger = new Logger(RealtimeSubscriptions.name);
  private readonly sources = new Map<RealtimeTopic, TopicSource>();
  /** Per topic: each subscriber, and whether it has had its snapshot (`ready`) yet. */
  private readonly subscribers = new Map<RealtimeTopic, Map<RealtimeClient, { ready: boolean }>>();
  /** The sources being collected: their `updates$` subscriptions. */
  private readonly running = new Map<RealtimeTopic, Subscription>();

  /** Called by each source on startup (like the auth package's `registerProvider`). */
  registerSource<T extends RealtimeTopic>(source: TopicSource<T>): void {
    if (this.sources.has(source.topic)) {
      throw new Error(`A source for the "${source.topic}" topic is already registered`);
    }
    this.sources.set(source.topic, source as unknown as TopicSource);
  }

  /** Idempotent. Sends the snapshot; never rejects (a failing source is logged). */
  async subscribe(client: RealtimeClient, topic: RealtimeTopic): Promise<void> {
    const subscribers = this.subscribersOf(topic);
    if (subscribers.has(client)) return;
    const state = { ready: false };
    subscribers.set(client, state);
    const source = this.sources.get(topic);
    if (!source) {
      state.ready = true;
      return;
    }
    if (subscribers.size === 1) this.start(source);
    try {
      const snapshot = await source.snapshot();
      // Still the same subscription? (It may have unsubscribed or disconnected meanwhile.)
      if (subscribers.get(client) !== state) return;
      sendMessage(client, { event: `${topic}:snapshot`, data: snapshot } as ServerMessage);
    } catch (error) {
      // A source may fail a snapshot it can no longer take because this client left — not an error.
      if (subscribers.get(client) !== state) return;
      this.logger.error(`The "${topic}" snapshot failed`, (error as Error).stack);
    }
    state.ready = true;
  }

  /** Idempotent. Stops the source when this was its last subscriber. */
  unsubscribe(client: RealtimeClient, topic: RealtimeTopic): void {
    const subscribers = this.subscribers.get(topic);
    if (!subscribers?.delete(client) || subscribers.size > 0) return;
    const source = this.sources.get(topic);
    if (source) this.stop(source);
  }

  /** A disconnected client leaves every topic. */
  removeClient(client: RealtimeClient): void {
    for (const topic of this.subscribers.keys()) this.unsubscribe(client, topic);
  }

  subscriberCount(topic: RealtimeTopic): number {
    return this.subscribers.get(topic)?.size ?? 0;
  }

  onModuleDestroy(): void {
    for (const subscribers of this.subscribers.values()) subscribers.clear();
    for (const source of this.sources.values()) this.stop(source);
  }

  private subscribersOf(topic: RealtimeTopic): Map<RealtimeClient, { ready: boolean }> {
    let subscribers = this.subscribers.get(topic);
    if (!subscribers) {
      subscribers = new Map();
      this.subscribers.set(topic, subscribers);
    }
    return subscribers;
  }

  private publish(topic: RealtimeTopic, update: UpdateData<RealtimeTopic>): void {
    const message = { event: `${topic}:update`, data: update } as ServerMessage;
    for (const [client, { ready }] of this.subscribers.get(topic) ?? []) {
      if (ready) sendMessage(client, message);
    }
  }

  private start(source: TopicSource): void {
    const subscription = source.updates$
      .pipe(
        // Sources catch their own errors; one that slips through restarts the source.
        retry({
          delay: (error: unknown) => {
            this.logger.error(`The "${source.topic}" source failed`, (error as Error)?.stack);
            return timer(SOURCE_RETRY_MS);
          },
        }),
      )
      .subscribe((update) => this.publish(source.topic, update));
    this.running.set(source.topic, subscription);
  }

  private stop(source: TopicSource): void {
    this.running.get(source.topic)?.unsubscribe();
    this.running.delete(source.topic);
  }
}
