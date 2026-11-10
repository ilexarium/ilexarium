import type { LogLine } from '@ilex/shared';

/** What the log view shows of a line: a container's (its stream), or the journal's. */
export interface LogViewEntry {
  id: number | string;
  at: string;
  text: string;
  stream?: LogLine['stream'];
  /** Who wrote it (`nginx[452]`). */
  source?: string | null;
  /** journald's priority, 0 (emergency) to 7 (debug). */
  priority?: number | null;
}
