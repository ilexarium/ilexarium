import type { LogLine, LogsEndReason } from '@homelab/shared';

/** A log line, or a marker for lines the server skipped in a flood. `id` is unique per stream. */
export type LogEntry =
  ({ kind: 'line'; id: number } & LogLine) | { kind: 'skipped'; id: number; count: number };

/**
 * - `idle`: not opened. `loading`: waiting for the first lines.
 * - `live`: following (possibly no output yet).
 * - `ended`: the server ended the stream — the container stopped, was removed, … (`reason`).
 * - `refused`: too many log views open on this connection.
 */
export type LogStreamState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'live' }
  | { status: 'ended'; reason: LogsEndReason }
  | { status: 'refused' };
