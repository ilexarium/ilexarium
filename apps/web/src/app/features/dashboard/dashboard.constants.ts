import { ALERT_LIMITS, type AlertKind } from '@laris/shared';
import type { Light, RackUnit } from './dashboard.model';

/** Mounts that are part of how the machine starts, nothing to act on: left out of Storage. */
export const HIDDEN_MOUNTS = ['/boot', '/boot/efi', '/efi'];

/** A disk's bar turns amber here, and red where its health alert opens. */
export const DISK_WARN_PERCENT = 80;
export const DISK_FAIL_PERCENT = ALERT_LIMITS.diskFullPercent;

/** Which unit of the rack an open alert lights. */
export const APP_ALERT_KINDS: AlertKind[] = [
  'serviceDown',
  'restartLoop',
  'unhealthy',
  'outOfMemory',
];
export const SPACE_ALERT_KINDS: AlertKind[] = ['diskFull', 'diskMissing'];

/** The days the backups' strip shows. */
export const BACKUP_DAYS = 14;

/** The catalog entry whose tile opens the Assistant. */
export const ASSISTANT_CATALOG_ID = 'ollama';

/** CPU use in words: below `quiet`, below `busy`, else very busy (percent). */
export const CPU_WORDS = { quiet: 25, busy: 75 };

/** Temperature in words (°C): warm and hot, or this far under the sensor's critical limit. */
export const TEMPERATURE_WORDS = { warm: 70, hot: 85, warmBelowCritical: 20, hotBelowCritical: 10 };

/** When the activity is fetched again after something changed (a burst of changes, one fetch). */
export const ACTIVITY_RELOAD_MS = 1_000;

/** Each status light's colour, and whether it pulses (it does while it says something). */
export const LIGHT_CLASSES: Record<Light, string> = {
  ok: 'text-light-ok motion-safe:animate-light-pulse',
  warn: 'text-light-warn motion-safe:animate-light-pulse',
  fail: 'text-light-fail motion-safe:animate-light-pulse',
  busy: 'text-primary motion-safe:animate-light-pulse',
  idle: 'text-muted-foreground/40',
};

/** The status word beside a light (a status is never told by colour alone). */
export const LIGHT_WORD_CLASSES: Record<Light, string> = {
  ok: 'text-success',
  warn: 'text-warning',
  fail: 'text-destructive',
  busy: 'text-primary',
  idle: 'text-muted-foreground',
};

export const RACK_ICONS: Record<RackUnit['id'], string> = {
  apps: 'lucideLayoutGrid',
  backups: 'lucideArchive',
  space: 'lucideHardDrive',
};
