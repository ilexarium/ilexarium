import type { Tone } from './metric-tiles.model';

/** A tile's word, as a small chip: plain, or a status colour when it's worth noticing. */
export const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'bg-accent text-accent-foreground',
  ok: 'bg-success-muted text-success',
  warn: 'bg-warning-muted text-warning',
  fail: 'bg-destructive-muted text-destructive',
};
