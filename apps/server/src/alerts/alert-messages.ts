import type { BackupWarning } from '@laris/shared';
import type { AlertEvent, AlertMessage, OpenAlert } from './alerts.model.js';

const BACKUP_TITLES: Record<BackupWarning, string> = {
  serviceNotRestarted: "A service wasn't started again after the backup",
  repositoryDamaged: 'The backup repository is damaged',
  lastRunFailed: 'The last backup failed',
  noRecentBackup: 'Nothing has been backed up for more than two days',
  destinationUnavailable: 'The backup disk is not connected',
  lowSpace: 'The backup disk is almost full',
};

/** What happened, in a few words: "Immich has stopped", "Disk /mnt/usb is 93 % full". */
export function alertTitle(alert: OpenAlert, serviceName: (catalogId: string) => string): string {
  const who = alert.details.catalogId ? serviceName(alert.details.catalogId) : alert.subject;
  switch (alert.kind) {
    case 'serviceDown':
      return `${who} has stopped`;
    case 'restartLoop':
      return `${who} keeps restarting`;
    case 'unhealthy':
      return `${who} is unhealthy`;
    case 'outOfMemory':
      return `${who} ran out of memory`;
    case 'diskFull':
      return `Disk ${alert.subject} is ${alert.details.percent ?? '?'} % full`;
    case 'diskMissing':
      return `Disk ${alert.subject} is not connected`;
    case 'backup':
      return BACKUP_TITLES[alert.subject as BackupWarning] ?? 'A backup problem';
  }
}

/** Where to look — never logs, values or secrets. */
function hint(alert: OpenAlert): string {
  switch (alert.kind) {
    case 'serviceDown':
    case 'restartLoop':
    case 'unhealthy':
    case 'outOfMemory':
      return `Container: ${alert.subject}. Its logs are on the Containers page.`;
    case 'diskFull':
    case 'diskMissing':
      return 'See the Disks page.';
    case 'backup':
      return 'See the Backups page.';
  }
}

/** A local time like 2026-10-17 14:02. */
function at(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * The message for an alert's event: one when it opens (or gets more serious), one when it closes,
 * a daily reminder of a critical one. English in v1 (the server doesn't know the user's language).
 */
export function alertMessage(
  event: AlertEvent,
  context: { host: string; now: Date; serviceName: (catalogId: string) => string },
): AlertMessage {
  const { alert } = event;
  const title = alertTitle(alert, context.serviceName);
  const where = `On ${context.host}`;
  switch (event.type) {
    case 'opened':
    case 'escalated':
      return {
        title,
        body: `${where}, since ${at(alert.openedAt)}. ${hint(alert)}`,
        severity: alert.severity,
      };
    case 'reminder':
      return {
        title: `Still: ${title}`,
        body: `${where}, since ${at(alert.openedAt)}. Acknowledge it in the app to stop these reminders. ${hint(alert)}`,
        severity: alert.severity,
      };
    case 'closed':
      return {
        title: `Resolved: ${title}`,
        body: `${where}, ${at(alert.openedAt)} to ${at(context.now)}.`,
        severity: 'resolved',
      };
  }
}

/** Messages held back by the hourly limit, as one. */
export function groupedMessage(messages: AlertMessage[], host: string): AlertMessage {
  const severity = messages.some((m) => m.severity === 'critical')
    ? 'critical'
    : messages.some((m) => m.severity === 'warning')
      ? 'warning'
      : 'resolved';
  return {
    title: `${messages.length} more alert messages`,
    body: `On ${host}, held back so as not to send too many:\n${messages.map((m) => `- ${m.title}`).join('\n')}`,
    severity,
  };
}
