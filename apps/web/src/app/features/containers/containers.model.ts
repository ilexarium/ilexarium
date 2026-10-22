import type { LogLine, LogsEndReason } from '@laris/shared';

/** A log line; `id` is unique per stream. */
export type LogEntry = { id: number } & LogLine;

/** `live` may have no output yet; `ended` is the server's decision, with its reason. */
export type LogStreamState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'live' }
  | { status: 'ended'; reason: LogsEndReason };
