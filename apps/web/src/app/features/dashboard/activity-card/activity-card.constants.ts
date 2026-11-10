import type { ActivityAction } from '@ilex/shared';

/** Each action's words (`dashboard.activity.action.<key>`), its icon, and whether its subject is machine text. */
export const ACTION_WORDS: Record<ActivityAction, { key: string; icon: string; machine: boolean }> =
  {
    'app.install': { key: 'appInstall', icon: 'lucidePackagePlus', machine: true },
    'app.update': { key: 'appUpdate', icon: 'lucideRefreshCw', machine: true },
    'app.remove': { key: 'appRemove', icon: 'lucidePackageMinus', machine: true },
    'container.start': { key: 'containerStart', icon: 'lucidePlay', machine: true },
    'container.stop': { key: 'containerStop', icon: 'lucideSquare', machine: true },
    'container.restart': { key: 'containerRestart', icon: 'lucideRotateCcw', machine: true },
    'backup.configure': { key: 'backupConfigure', icon: 'lucideShieldCheck', machine: false },
    'backup.restore': { key: 'backupRestore', icon: 'lucideHistory', machine: false },
    'disk.mount': { key: 'diskMount', icon: 'lucideHardDrive', machine: true },
    'disk.unmount': { key: 'diskUnmount', icon: 'lucideHardDrive', machine: true },
  };

/** The icon's colours: what people did plainly, outcomes in their status colour. */
export const ACTIVITY_TONE_CLASSES = {
  neutral: 'bg-accent text-accent-foreground',
  ok: 'bg-success-muted text-success',
  warn: 'bg-warning-muted text-warning',
  fail: 'bg-destructive-muted text-destructive',
} as const;
