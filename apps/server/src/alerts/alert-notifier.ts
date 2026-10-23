import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ALERT_LIMITS } from '@laris/shared';
import { hostname } from 'node:os';
import { concatMap, exhaustMap, interval, type Subscription } from 'rxjs';
import { CatalogService } from '../catalog/catalog.service.js';
import { safely } from '../common/safely.js';
import { alertMessage, groupedMessage } from './alert-messages.js';
import { AlertChannels } from './alert-channels.js';
import { AlertRecords } from './alert-records.js';
import type { AlertEvent, AlertMessage, ChannelConfig } from './alerts.model.js';
import { HOUR_MS, REMINDER_CHECK_MS, RETRY_AFTER_MS } from './alerts.constants.js';

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
  /** Messages over the hour's limit, and the alerts they're for (marked sent once they go). */
  private held: { message: AlertMessage; alertId: string | null }[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly retries = new Set<NodeJS.Timeout>();
  private readonly subscriptions: Subscription[] = [];

  constructor(
    private readonly alertRecords: AlertRecords,
    private readonly alertChannels: AlertChannels,
    private readonly catalogService: CatalogService,
  ) {}

  onModuleInit(): void {
    this.subscriptions.push(
      this.alertRecords.events$
        .pipe(
          concatMap((event) =>
            safely(this.handle(event), (error) =>
              this.logger.error('Sending an alert message failed', (error as Error).stack),
            ),
          ),
        )
        .subscribe(),
      interval(REMINDER_CHECK_MS)
        .pipe(
          exhaustMap(() =>
            safely(this.remind(), (error) =>
              this.logger.error('Sending reminders failed', (error as Error).stack),
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
    await this.send(this.message(event), event.type === 'closed' ? null : event.alert.id);
  }

  /**
   * Critical alerts still open and not acknowledged a day after their last message — or never
   * sent (no channel was switched on when they opened).
   */
  async remind(): Promise<void> {
    const waiting = new Set(this.held.map((h) => h.alertId));
    for (const alert of await this.alertRecords.dueReminders(new Date())) {
      if (waiting.has(alert.id)) continue;
      await this.send(this.message({ type: 'reminder', alert }), alert.id);
    }
  }

  private message(event: AlertEvent): AlertMessage {
    return alertMessage(event, {
      host: this.host,
      now: new Date(),
      serviceName: (id) => this.catalogService.get(id)?.meta.name ?? id,
    });
  }

  /**
   * Sends now, or holds it when the hour's 10 are used; nothing without a channel switched on.
   * The alert counts as sent (`lastSentAt`) only once its message has gone out.
   */
  private async send(message: AlertMessage, alertId: string | null): Promise<void> {
    const channels = await this.alertChannels.enabled();
    if (channels.length === 0) return;
    if (!this.takeSlot()) {
      this.held.push({ message, alertId });
      this.scheduleFlush();
      return;
    }
    await this.deliver(channels, message);
    if (alertId) await this.alertRecords.markSent(alertId, new Date());
  }

  private async deliver(channels: ChannelConfig[], message: AlertMessage): Promise<void> {
    await Promise.all(
      channels.map(async (config) => {
        if ((await this.alertChannels.sendTo(config, message)) === null) return;
        const timer = setTimeout(() => {
          this.retries.delete(timer);
          void this.alertChannels.sendTo(config, message).catch(() => undefined);
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
    // Switched off meanwhile: dropped, not counted as sent (critical ones are reminded later).
    const channels = await this.alertChannels.enabled();
    if (channels.length === 0) return;
    const messages = held.map((h) => h.message);
    await this.deliver(
      channels,
      messages.length === 1 ? messages[0] : groupedMessage(messages, this.host),
    );
    const now = new Date();
    for (const { alertId } of held) if (alertId) await this.alertRecords.markSent(alertId, now);
  }
}
