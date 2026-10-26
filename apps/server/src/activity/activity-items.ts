import { type ActivityItem, activityActionSchema } from '@laris/shared';
import type { Alert as AlertRow, AuditEvent, BackupRun } from '../generated/prisma/client.js';
import { toAlertView } from '../alerts/alert-records.js';
import { ACTIVITY_SUBJECTS } from './activity.constants.js';

type Names = (catalogId: string) => string | null;

/** An audit entry as an activity: its action, who, and at most one checked detail. */
export function fromAudit(event: AuditEvent, serviceName: Names): ActivityItem | null {
  const action = activityActionSchema.safeParse(event.action);
  if (!action.success || event.outcome !== 'success') return null;
  const rule = ACTIVITY_SUBJECTS[action.data];
  const details = (event.details ?? {}) as Record<string, unknown>;
  const value = rule ? details[rule.field] : undefined;
  let subject = typeof value === 'string' && rule?.valid(value) ? value : null;
  if (subject && rule?.field === 'catalogId') subject = serviceName(subject) ?? subject;
  return {
    source: 'action',
    id: event.id,
    at: event.at.toISOString(),
    action: action.data,
    username: event.username,
    subject,
  };
}

export function fromBackupRun(run: BackupRun): ActivityItem | null {
  if (!run.finishedAt || run.status === 'running') return null;
  return {
    source: 'backup',
    id: run.id,
    at: run.finishedAt.toISOString(),
    trigger: run.trigger,
    status: run.status,
  };
}

/** An alert opened, and closed if it was. */
export function fromAlert(row: AlertRow, serviceName: Names): ActivityItem[] {
  const alert = toAlertView(row, serviceName);
  const items: ActivityItem[] = [
    { source: 'alert', id: `${row.id}-opened`, at: alert.openedAt, event: 'opened', alert },
  ];
  if (alert.closedAt) {
    items.push({
      source: 'alert',
      id: `${row.id}-closed`,
      at: alert.closedAt,
      event: 'closed',
      alert,
    });
  }
  return items;
}

/** Newest first, at most `limit`. */
export function mergeActivity(items: (ActivityItem | null)[], limit: number): ActivityItem[] {
  return items
    .filter((item) => item !== null)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
}
