import type { Alert } from '@homelab/shared';
import type { Formatter } from '../../shared/format/formatter';

/** A translation key and its params. */
export type Wording = [key: string, params?: Record<string, unknown>];

/** What happened, in a few words: "Immich has stopped", "Disk /mnt/usb is 93 % full". */
export function alertTitle(alert: Alert, formatter: Formatter): Wording {
  if (alert.kind === 'backup') return [`backups.warning.${alert.warning}.title`];
  return [
    `alerts.kind.${alert.kind}`,
    {
      name: alert.serviceName ?? formatter.machine(alert.subject),
      path: formatter.machine(alert.subject),
      percent: formatter.percent(alert.percent ?? 0),
    },
  ];
}

/** What it means and what to do. */
export function alertText(alert: Alert): Wording {
  if (alert.kind === 'backup') return [`backups.warning.${alert.warning}.text`];
  return [`alerts.text.${alert.kind}`];
}

/** Where to look: the container's logs, the Disks or the Backups page. */
export function alertLink(alert: Alert): { link: string[]; label: string } {
  switch (alert.kind) {
    case 'diskFull':
    case 'diskMissing':
      return { link: ['/disks'], label: 'alerts.action.disks' };
    case 'backup':
      return { link: ['/backups'], label: 'alerts.action.backups' };
    default:
      return { link: ['/containers', alert.subject, 'logs'], label: 'alerts.action.logs' };
  }
}
