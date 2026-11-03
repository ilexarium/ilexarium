import type { Container, LogLine, LogsEndReason } from '@laris/shared';

/** A log line; `id` is unique per stream. */
export type LogEntry = { id: number } & LogLine;

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

/** `live` may have no output yet; `ended` is the server's decision, with its reason. */
export type LogStreamState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'live' }
  | { status: 'ended'; reason: LogsEndReason };

/** The containers of one app, or (`app` null) of none: outside Compose, or the platform's own. */
export interface ContainerGroup {
  app: { name: string; templateId: string | null } | null;
  containers: Container[];
  running: number;
}
