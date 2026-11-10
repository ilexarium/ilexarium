import {
  BACKUP_ERROR_CODES,
  BACKUP_LIMITS,
  BACKUP_WARNINGS,
  type BackupSchedule,
  type BackupWarning,
} from '@ilex/shared';
import { LOW_SPACE_SHARE } from './backups.constants.js';
import type { WarningInput } from './backups.model.js';

/**
 * The problems shown across the app (dashboard, a badge on "Backups"), most serious first:
 * a service not started again, a damaged repository, a failed last run, nothing backed up for
 * more than two days (the item backed up longest ago counts), the disk missing or nearly full.
 */
export function backupWarnings(input: WarningInput): BackupWarning[] {
  const found = new Set<BackupWarning>();
  if (input.items.some((item) => item.lastErrorCode === BACKUP_ERROR_CODES.serviceNotRestarted)) {
    found.add('serviceNotRestarted');
  }
  if (
    input.lastCheck?.status === 'failed' &&
    input.lastCheck.errorCode === BACKUP_ERROR_CODES.repositoryDamaged
  ) {
    found.add('repositoryDamaged');
  }
  if (input.lastRun?.status === 'failed') found.add('lastRunFailed');
  // Never backed up counts from when the plan was set up (no warning on day one).
  const oldest = Math.min(
    ...input.items.map((item) => (item.lastSuccessAt ?? input.planCreatedAt).getTime()),
  );
  if (
    input.items.length > 0 &&
    input.now.getTime() - oldest > BACKUP_LIMITS.staleAfterHours * 3_600_000
  ) {
    found.add('noRecentBackup');
  }
  if (input.destination && !input.destination.mounted) found.add('destinationUnavailable');
  const space = input.destination;
  if (
    space?.mounted &&
    space.totalBytes > 0 &&
    space.freeBytes / space.totalBytes < LOW_SPACE_SHARE
  ) {
    found.add('lowSpace');
  }
  return BACKUP_WARNINGS.filter((warning) => found.has(warning));
}

/** The hours a schedule runs at: its time's hour, and every 12 or 6 hours from it. */
export function scheduleHours(schedule: BackupSchedule): number[] {
  const hour = Number(schedule.time.slice(0, 2));
  const step = { daily: 24, every12h: 12, every6h: 6 }[schedule.frequency];
  const hours: number[] = [];
  for (let h = hour % step; h < 24; h += step) hours.push(h);
  return hours;
}

/**
 * When the timer runs next (the server's local time, like systemd's OnCalendar; the timer may add
 * up to 10 minutes of random delay).
 */
export function nextRunAt(schedule: BackupSchedule, now: Date): Date {
  const minute = Number(schedule.time.slice(3, 5));
  const hours = scheduleHours(schedule);
  for (let day = 0; day < 2; day++) {
    for (const hour of hours) {
      const at = new Date(now);
      at.setDate(now.getDate() + day);
      at.setHours(hour, minute, 0, 0);
      if (at.getTime() > now.getTime()) return at;
    }
  }
  return now; // not reached: tomorrow always has a time
}
