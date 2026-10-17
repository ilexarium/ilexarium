import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ALERT_LIMITS } from '@homelab/shared';
import { hostname } from 'node:os';
import { catchError, concatMap, EMPTY, exhaustMap, from, interval, type Subscription } from 'rxjs';
import { CatalogService } from '../catalog/catalog.service.js';
import { alertMessage, groupedMessage } from './alert-messages.js';
import { AlertChannels } from './alert-channels.js';
import { AlertRecords } from './alert-records.js';
import type { AlertEvent, AlertMessage, ChannelConfig } from './alerts.model.js';

const HOUR_MS = 3_600_000;
/** A message not delivered is tried once more after this long. */
export const RETRY_AFTER_MS = 60_000;
/** How often due reminders are looked for. */
export const REMINDER_CHECK_MS = 10 * 60_000;

/**
 * Sends the alerts' messages (docs/plans/health_alerts.md) through the channels switched on —
 * not crying wolf: one when an alert opens (or gets more serious), one when it closes, a daily
 * reminder of a critical one until acknowledged, and **at most 10 messages an hour** (the rest
 * held and sent as one when the hour allows). A message not delivered is tried once more after a
 * minute, then left for the next one; the alert shows in the app either way.
 */
@Injectable()
export class AlertNotifier implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AlertNotifier.name);
  private readonly host = hostname();
  /** When the messages of the last hour were sent. */
  private sentAt: number[] = [];
  private held: AlertMessage[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly retries = new Set<NodeJS.Timeout>();
  private readonly subscriptions: Subscription[] = [];

  constructor(
    private readonly records: AlertRecords,
    private readonly channels: AlertChannels,
    private readonly catalog: CatalogService,
  ) {}

  onModuleInit(): void {
    this.subscriptions.push(
      this.records.events$
        .pipe(
          concatMap((event) =>
            from(this.handle(event)).pipe(
              catchError((error: unknown) => {
                this.logger.error('Sending an alert message failed', (error as Error).stack);
                return EMPTY;
              }),
            ),
          ),
        )
        .subscribe(),
      interval(REMINDER_CHECK_MS)
        .pipe(
          exhaustMap(() =>
            from(this.remind()).pipe(
              catchError((error: unknown) => {
                this.logger.error('Sending reminders failed', (error as Error).stack);
                return EMPTY;
              }),
            ),
          ),
        )
        .subscribe(),
    );
  }

  onModuleDestroy(): void {
    for (const subscription of this.subscriptions) subscription.unsubscribe();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    for (const timer of this.retries) clearTimeout(timer);
    this.retries.clear();
  }

  /** An alert opened, got more serious or closed. */
  async handle(event: AlertEvent): Promise<void> {
    // Out of memory is a one-off event: its closing an hour later is no news.
    if (event.type === 'closed' && event.alert.kind === 'outOfMemory') return;
    const sent = await this.send(this.message(event));
    if (sent && event.type !== 'closed') await this.records.markSent(event.alert.id, new Date());
  }

  /** Critical alerts still open and not acknowledged a day after their last message. */
  async remind(): Promise<void> {
    for (const alert of await this.records.dueReminders(new Date())) {
      if (await this.send(this.message({ type: 'reminder', alert }))) {
        await this.records.markSent(alert.id, new Date());
      }
    }
  }

  private message(event: AlertEvent): AlertMessage {
    return alertMessage(event, {
      host: this.host,
      now: new Date(),
      serviceName: (id) => this.catalog.get(id)?.meta.name ?? id,
    });
  }

  /** Sends now, or holds it when the hour's 10 are used. False when no channel is switched on. */
  private async send(message: AlertMessage): Promise<boolean> {
    const channels = await this.channels.enabled();
    if (channels.length === 0) return false;
    if (!this.takeSlot()) {
      this.held.push(message);
      this.scheduleFlush();
      return true;
    }
    await this.deliver(channels, message);
    return true;
  }

  private async deliver(channels: ChannelConfig[], message: AlertMessage): Promise<void> {
    await Promise.all(
      channels.map(async (config) => {
        if ((await this.channels.sendTo(config, message)) === null) return;
        const timer = setTimeout(() => {
          this.retries.delete(timer);
          void this.channels.sendTo(config, message).catch(() => undefined);
        }, RETRY_AFTER_MS);
        this.retries.add(timer);
      }),
    );
  }

  /** One of the hour's messages, if there's one left. */
  private takeSlot(): boolean {
    const now = Date.now();
    this.sentAt = this.sentAt.filter((at) => now - at < HOUR_MS);
    if (this.sentAt.length >= ALERT_LIMITS.messagesPerHour) return false;
    this.sentAt.push(now);
    return true;
  }

  /** When the oldest of the hour's messages is an hour old, the held ones go as one. */
  private scheduleFlush(): void {
    if (this.flushTimer) return;
    const wait = Math.max(0, this.sentAt[0] + HOUR_MS - Date.now());
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush().catch((error: unknown) =>
        this.logger.error('Sending held alert messages failed', (error as Error).stack),
      );
    }, wait);
  }

  private async flush(): Promise<void> {
    if (this.held.length === 0) return;
    if (!this.takeSlot()) {
      this.scheduleFlush();
      return;
    }
    const held = this.held;
    this.held = [];
    const channels = await this.channels.enabled();
    if (channels.length === 0) return;
    await this.deliver(channels, held.length === 1 ? held[0] : groupedMessage(held, this.host));
  }
}
