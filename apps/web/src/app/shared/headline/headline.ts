import type { Headline } from './headline.model';

/**
 * How a page's things are doing, in one sentence: those needing attention first, then all running
 * or how many. Keys `<prefix>.attention`, `.allRunning`, `.someRunning` (plurals).
 */
export function headline(
  prefix: string,
  total: number,
  attention: number,
  running: number,
): Headline {
  if (attention > 0) return { key: `${prefix}.attention`, count: attention, total };
  return running === total
    ? { key: `${prefix}.allRunning`, count: total, total }
    : { key: `${prefix}.someRunning`, count: running, total };
}
