import type { LogLine, LogsEndReason } from '@homelab/shared';

/** A log line; `id` is unique per stream. */
export type LogEntry = { id: number } & LogLine;

/**
 * - `idle`: not opened. `loading`: waiting for the first lines.
 * - `live`: following (possibly no output yet).
 * - `ended`: the server ended the stream — the container stopped, was removed, … (`reason`).
 * - `refused`: too many log views open in this sign-in.
 */
export type LogStreamState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'live' }
  | { status: 'ended'; reason: LogsEndReason }
  | { status: 'refused' };
