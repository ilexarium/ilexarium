import type { DotTone } from './status-dot.model';

/** In the dashboard's light colours. */
export const DOT_CLASSES: Record<DotTone, string> = {
  live: 'text-light-ok motion-safe:animate-light-pulse',
  busy: 'text-light-warn motion-safe:animate-light-pulse',
  ok: 'text-light-ok',
  warn: 'text-light-warn',
  fail: 'text-light-fail',
  idle: 'text-muted-foreground',
};
