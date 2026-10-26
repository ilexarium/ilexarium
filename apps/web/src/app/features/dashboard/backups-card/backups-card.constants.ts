import type { BackupDay } from '../dashboard.model';

/** A day of the strip: green, amber or red by its worst run; faint without one. */
export const DAY_CLASSES: Record<NonNullable<BackupDay['outcome']> | 'none', string> = {
  ok: 'bg-light-ok',
  warning: 'bg-light-warn',
  failed: 'bg-light-fail',
  none: 'bg-muted',
};
