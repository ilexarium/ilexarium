import type { Container, LogLine, LogsEndReason } from '@ilex/shared';

/** A log line; `id` is unique per stream. */
export type LogEntry = { id: number } & LogLine;

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
