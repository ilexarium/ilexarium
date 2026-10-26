import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ALERT_LIMITS, type Alert, type AlertKind, type BackupWarning } from '@laris/shared';
import { type Observable, Subject } from 'rxjs';
import type { Alert as AlertRow } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AlertCondition, AlertDetails, AlertEvent, OpenAlert } from './alerts.model.js';
import {
  CLOSED_SHOWN_DAYS,
  CLOSED_SHOWN_MAX,
  NEVER_SENT_AFTER_MS,
  SEVERITY_RANK,
} from './alerts.constants.js';

const key = (kind: string, subject: string) => `${kind}\u0000${subject}`;

/**
 * The `Alert` table (docs/plans/health_alerts.md). The rules report what should be open
 * (`reconcile`); this opens what's new, closes what's gone — **one open alert per kind and
 * subject** — and tells the messages (`events$`) and the topic (`changes$`). Changes are written
 * one at a time, in order, from a copy of the open alerts kept here.
 */
@Injectable()
export class AlertRecords implements OnModuleInit {
  private readonly logger = new Logger(AlertRecords.name);
  private readonly openAlerts = new Map<string, OpenAlert>();
  private readonly changed = new Subject<void>();
  private readonly happened = new Subject<AlertEvent>();
  private queue: Promise<unknown> = Promise.resolve();
  private loaded: Promise<void> | null = null;

  /** Something about the alerts changed (opened, closed, acknowledged). */
  readonly changes$: Observable<void> = this.changed.asObservable();
  /** Alerts opened, made more serious and closed — what messages are sent for. */
  readonly events$: Observable<AlertEvent> = this.happened.asObservable();

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): Promise<void> {
    return this.load();
  }

  /** The open alerts as they were stored — for the rules to pick up after a restart. */
  async open(): Promise<OpenAlert[]> {
    await this.load();
    return [...this.openAlerts.values()];
  }

  /**
   * What a rule sees now, for the kinds it decides: opens alerts for new conditions, updates
   * changed ones (a more serious one is an event), closes open ones of those kinds not listed.
   */
  reconcile(kinds: readonly AlertKind[], conditions: AlertCondition[]): Promise<void> {
    return this.serially(async () => {
      const now = new Date();
      const seen = new Set<string>();
      for (const condition of conditions) {
        const id = key(condition.kind, condition.subject);
        if (seen.has(id)) continue;
        seen.add(id);
        const existing = this.openAlerts.get(id);
        if (!existing) await this.create(id, condition, now);
        else await this.update(id, existing, condition);
      }
      for (const [id, alert] of this.openAlerts) {
        if (kinds.includes(alert.kind) && !seen.has(id)) await this.close(id, alert, now);
      }
    });
  }

  /** Acknowledges an open alert (no more reminders); false if there's no such open alert. */
  acknowledge(id: string, user: { id: string; username: string }): Promise<boolean> {
    return this.serially(async () => {
      // The table decides (not the copy kept here): an open alert, acknowledged or not yet.
      const acknowledgedAt = new Date();
      const { count } = await this.prisma.alert.updateMany({
        where: { id, closedAt: null, acknowledgedAt: null },
        data: { acknowledgedAt, acknowledgedById: user.id, acknowledgedBy: user.username },
      });
      if (count === 0) {
        return (await this.prisma.alert.count({ where: { id, closedAt: null } })) > 0;
      }
      for (const [mapKey, alert] of this.openAlerts) {
        if (alert.id === id) this.openAlerts.set(mapKey, { ...alert, acknowledgedAt });
      }
      this.changed.next();
      return true;
    });
  }

  /** A message was sent for it (opened, or a reminder). */
  markSent(id: string, at: Date): Promise<void> {
    return this.serially(async () => {
      await this.prisma.alert.update({ where: { id }, data: { lastSentAt: at } });
      for (const [mapKey, alert] of this.openAlerts) {
        if (alert.id === id) this.openAlerts.set(mapKey, { ...alert, lastSentAt: at });
      }
    });
  }

  /**
   * Critical alerts open and not acknowledged: last sent more than a day ago (reminded once a day),
   * or never sent and open for a while (no channel was switched on when they opened; the wait
   * leaves the opening message time to go first).
   */
  async dueReminders(now: Date): Promise<OpenAlert[]> {
    await this.load();
    return [...this.openAlerts.values()].filter(
      (alert) =>
        alert.severity === 'critical' &&
        !alert.acknowledgedAt &&
        (alert.lastSentAt === null
          ? now.getTime() - alert.openedAt.getTime() >= NEVER_SENT_AFTER_MS
          : now.getTime() - alert.lastSentAt.getTime() >= 86_400_000),
    );
  }

  /** Deletes alerts closed more than 30 days ago. */
  async prune(now: Date): Promise<void> {
    const before = new Date(now.getTime() - ALERT_LIMITS.keepClosedDays * 86_400_000);
    await this.prisma.alert.deleteMany({ where: { closedAt: { lt: before } } });
  }

  /** Open alerts (critical first, newest first) and recently closed ones. */
  async view(
    serviceName: (catalogId: string) => string | null = () => null,
    now = new Date(),
  ): Promise<{ open: Alert[]; closed: Alert[] }> {
    const since = new Date(now.getTime() - CLOSED_SHOWN_DAYS * 86_400_000);
    const [open, closed] = await Promise.all([
      this.prisma.alert.findMany({ where: { closedAt: null }, orderBy: { openedAt: 'desc' } }),
      this.prisma.alert.findMany({
        where: { closedAt: { gte: since } },
        orderBy: { closedAt: 'desc' },
        take: CLOSED_SHOWN_MAX,
      }),
    ]);
    open.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
    const view = (row: AlertRow) => toAlertView(row, serviceName);
    return { open: open.map(view), closed: closed.map(view) };
  }

  private async create(id: string, condition: AlertCondition, now: Date): Promise<void> {
    const row = await this.prisma.alert.create({
      data: {
        kind: condition.kind,
        subject: condition.subject,
        severity: condition.severity,
        details: { ...condition.details },
        openedAt: now,
      },
    });
    const alert = toOpen(row);
    this.openAlerts.set(id, alert);
    this.changed.next();
    this.happened.next({ type: 'opened', alert });
  }

  private async update(id: string, existing: OpenAlert, condition: AlertCondition): Promise<void> {
    const sameDetails = JSON.stringify(existing.details) === JSON.stringify(condition.details);
    if (existing.severity === condition.severity && sameDetails) return;
    await this.prisma.alert.update({
      where: { id: existing.id },
      data: { severity: condition.severity, details: { ...condition.details } },
    });
    const alert = { ...existing, severity: condition.severity, details: condition.details };
    this.openAlerts.set(id, alert);
    this.changed.next();
    if (SEVERITY_RANK[condition.severity] > SEVERITY_RANK[existing.severity]) {
      this.happened.next({ type: 'escalated', alert });
    }
  }

  private async close(id: string, alert: OpenAlert, now: Date): Promise<void> {
    await this.prisma.alert.update({ where: { id: alert.id }, data: { closedAt: now } });
    this.openAlerts.delete(id);
    this.changed.next();
    this.happened.next({ type: 'closed', alert });
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      const rows = await this.prisma.alert.findMany({ where: { closedAt: null } });
      for (const row of rows) this.openAlerts.set(key(row.kind, row.subject), toOpen(row));
    })();
    return this.loaded;
  }

  /** One change at a time; a failed one is logged and doesn't stop the next. */
  private serially<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      await this.load();
      return work();
    });
    this.queue = run.catch((error: unknown) =>
      this.logger.error('Writing an alert failed', (error as Error).stack),
    );
    return run;
  }
}

function toOpen(row: AlertRow): OpenAlert {
  return {
    id: row.id,
    kind: row.kind as AlertKind,
    subject: row.subject,
    severity: row.severity,
    details: (row.details ?? {}) as AlertDetails,
    openedAt: row.openedAt,
    acknowledgedAt: row.acknowledgedAt,
    lastSentAt: row.lastSentAt,
  };
}

export function toAlertView(
  row: AlertRow,
  serviceName: (catalogId: string) => string | null,
): Alert {
  const details = (row.details ?? {}) as AlertDetails;
  return {
    id: row.id,
    kind: row.kind as AlertKind,
    subject: row.subject,
    severity: row.severity,
    catalogId: details.catalogId ?? null,
    serviceName: details.catalogId ? serviceName(details.catalogId) : null,
    percent: details.percent ?? null,
    warning: row.kind === 'backup' ? (row.subject as BackupWarning) : null,
    openedAt: row.openedAt.toISOString(),
    closedAt: row.closedAt?.toISOString() ?? null,
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
    acknowledgedBy: row.acknowledgedBy,
  };
}
