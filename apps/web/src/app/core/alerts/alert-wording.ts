import type { Alert } from '@ilex/shared';
import type { Formatter } from '../../shared/format/formatter';

/** A translation key and its params. */
export type Wording = [key: string, params?: Record<string, unknown>];

/** What happened, in a few words: "Immich has stopped", "Disk /mnt/usb is 93 % full". */
export function alertTitle(alert: Alert, formatter: Formatter): Wording {
  if (alert.kind === 'backup') return [`backups.warning.${alert.warning}.title`];
  return [
    `alerts.kind.${alert.kind}`,
    {
      name: formatter.machine(alert.app ?? alert.subject),
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

/** Its icon and the icon's colour: resolved, critical or a warning. */
export function alertIcon(alert: Alert): { icon: string; color: string } {
  if (alert.closedAt) return { icon: 'lucideCircleCheck', color: 'text-muted-foreground' };
  return alert.severity === 'critical'
    ? { icon: 'lucideCircleAlert', color: 'text-destructive' }
    : { icon: 'lucideTriangleAlert', color: 'text-warning' };
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

/**
 * A full disk often has Docker's unused data on it: an open one also links to freeing that
 * (docs/plans/docker_cleanup.md).
 */
export function alertFreesSpace(alert: Alert): boolean {
  return alert.kind === 'diskFull' && !alert.closedAt;
}
