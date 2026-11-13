import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ALERT_LIMITS } from '@ilex/shared';
import { hostname } from 'node:os';
import { concatMap, exhaustMap, interval, type Subscription } from 'rxjs';
import { safely } from '../common/safely.js';
import { alertMessage, groupedMessage } from './alert-messages.js';
import { AlertChannels } from './alert-channels.js';
import { AlertRecords } from './alert-records.js';
import type { AlertEvent, AlertMessage, ChannelConfig } from './alerts.model.js';
import { HOUR_MS, REMINDER_CHECK_MS, RETRY_AFTER_MS } from './alerts.constants.js';

/**
 * Sends the alerts' messages through the channels switched on —
 * not crying wolf: one when an alert opens (or gets more serious), one when it closes, a daily
 * reminder of a critical one until acknowledged, and **at most 10 messages an hour** (the rest
 * held and sent as one when the hour allows). A message that reached no channel is tried once more
 * after a minute; an open alert whose message never got through is sent again by the reminder
 * check until it does ("Resolved" messages only get the one retry). The alert shows in the app
 * either way.
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
  /** Shutting down: a delivery still under way schedules no more timers. */
  private stopped = false;

  constructor(
    private readonly alertRecords: AlertRecords,
    private readonly alertChannels: AlertChannels,
  ) {}

  onModuleInit(): void {
    this.subscriptions.push(
      this.alertRecords.events$
        .pipe(
          concatMap((event) =>
            safely(
              () => this.handle(event),
              (error) =>
                this.logger.error('Sending an alert message failed', (error as Error).stack),
            ),
          ),
        )
        .subscribe(),
      interval(REMINDER_CHECK_MS)
        .pipe(
          exhaustMap(() =>
            safely(
              () => this.remind(),
              (error) => this.logger.error('Sending reminders failed', (error as Error).stack),
            ),
          ),
        )
        .subscribe(),
    );
  }

  onModuleDestroy(): void {
    this.stopped = true;
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
   * Open alerts never sent (no channel was switched on, or every one failed) — their opening
   * message — and critical ones not acknowledged a day after their last message. The first message
   * no channel takes ends the round: while the channels fail, one try every check, not one per alert.
   */
  async remind(): Promise<void> {
    const waiting = new Set(this.held.map((h) => h.alertId));
    for (const alert of await this.alertRecords.dueReminders(new Date())) {
      if (waiting.has(alert.id)) continue;
      const type = alert.lastSentAt === null ? 'opened' : 'reminder';
      if (!(await this.send(this.message({ type, alert }), alert.id))) return;
    }
  }

  private message(event: AlertEvent): AlertMessage {
    return alertMessage(event, {
      host: this.host,
      now: new Date(),
    });
  }

  /**
   * Sends now, or holds it when the hour's 10 are used; nothing without a channel switched on.
   * The alert counts as sent (`lastSentAt`) only once its message has reached a channel.
   * False when no channel took it now (none switched on, or every one failed).
   */
  private async send(message: AlertMessage, alertId: string | null): Promise<boolean> {
    const channels = await this.alertChannels.enabled();
    if (channels.length === 0) return false;
    const slot = this.takeSlot();
    if (slot === null) {
      this.held.push({ message, alertId });
      this.scheduleFlush();
      return true;
    }
    return this.deliver(channels, message, alertId ? [alertId] : [], slot);
  }

  /**
   * Through every channel; the ones that failed are tried once more after a minute. The alerts
   * count as sent when one channel has the message. One that reached no channel even on the retry
   * gives its slot back: the hour's 10 are messages delivered, so failures during an outage don't
   * hold back the messages after it.
   */
  private async deliver(
    channels: ChannelConfig[],
    message: AlertMessage,
    alertIds: string[],
    slot: number | null,
    retry = true,
  ): Promise<boolean> {
    const problems = await Promise.all(
      channels.map((config) => this.alertChannels.sendTo(config, message)),
    );
    const failed = channels.filter((_, i) => problems[i] !== null);
    const delivered = failed.length < channels.length;
    if (delivered) await this.markSent(alertIds);
    else if (!retry) this.giveBack(slot);
    if (retry && failed.length > 0 && !this.stopped) {
      const timer = setTimeout(() => {
        this.retries.delete(timer);
        // Delivered already: the retry only completes the other channels.
        void this.deliver(
          failed,
          message,
          delivered ? [] : alertIds,
          delivered ? null : slot,
          false,
        ).catch((error: unknown) =>
          this.logger.error('Retrying an alert message failed', (error as Error).stack),
        );
      }, RETRY_AFTER_MS);
      this.retries.add(timer);
    }
    return delivered;
  }

  private async markSent(alertIds: string[]): Promise<void> {
    const now = new Date();
    for (const id of alertIds) await this.alertRecords.markSent(id, now);
  }

  /** One of the hour's messages, if there's one left: when it was taken, or null. */
  private takeSlot(): number | null {
    const now = Date.now();
    this.sentAt = this.sentAt.filter((at) => now - at < HOUR_MS);
    if (this.sentAt.length >= ALERT_LIMITS.messagesPerHour) return null;
    this.sentAt.push(now);
    return now;
  }

  private giveBack(slot: number | null): void {
    const index = slot === null ? -1 : this.sentAt.indexOf(slot);
    if (index >= 0) this.sentAt.splice(index, 1);
  }

  /** When the oldest of the hour's messages is an hour old, the held ones go as one. */
  private scheduleFlush(): void {
    if (this.flushTimer || this.stopped) return;
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
    const slot = this.takeSlot();
    if (slot === null) {
      this.scheduleFlush();
      return;
    }
    const held = this.held;
    this.held = [];
    // Switched off meanwhile: dropped, not counted as sent (sent again by the reminder check).
    const channels = await this.alertChannels.enabled();
    if (channels.length === 0) {
      this.giveBack(slot);
      return;
    }
    const messages = held.map((h) => h.message);
    await this.deliver(
      channels,
      messages.length === 1 ? messages[0] : groupedMessage(messages, this.host),
      held.flatMap((h) => (h.alertId ? [h.alertId] : [])),
      slot,
    );
  }
}
