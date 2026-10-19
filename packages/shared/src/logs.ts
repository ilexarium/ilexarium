import { z } from 'zod';

export const LOG_LIMITS = {
  /** Open log streams per sign-in — below the browser's 6 connections per site over HTTP/1.1. */
  maxStreamsPerSession: 4,
  /** Lines of history sent first, before following. */
  minTail: 1,
  maxTail: 5000,
  defaultTail: 500,
  /** Longer lines are cut and marked `truncated`. */
  maxLineBytes: 16 * 1024,
  /** Lines the log view keeps in memory. */
  maxLinesInView: 10_000,
} as const;

/**
 * A container name, as Docker allows it and the socket proxy's path pattern accepts it.
 * Containers are identified by name: Compose keeps it when it recreates a container, not the ID.
 */
export const containerNameSchema = z
  .string()
  .max(255)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);

/**
 * Docker's own timestamp (RFC 3339, UTC, up to nanoseconds), passed on unchanged: rounding it
 * would duplicate or lose lines logged in the same millisecond when resuming with `since`.
 */
export const logTimestampSchema = z.iso.datetime();

export const LOG_STREAMS = ['stdout', 'stderr'] as const;
export const logStreamSchema = z.enum(LOG_STREAMS);
export type LogStream = z.infer<typeof logStreamSchema>;

export const logLineSchema = z.object({
  at: logTimestampSchema,
  stream: logStreamSchema,
  /** Plain text, ANSI escape codes stripped. May contain secrets — always render as text. */
  text: z.string(),
  /** The line was longer than `LOG_LIMITS.maxLineBytes` and was cut. */
  truncated: z.literal(true).optional(),
});
export type LogLine = z.infer<typeof logLineSchema>;

/** The logs of one container, as Server-Sent Events: `GET /api/containers/:name/logs`. */
export function containerLogsPath(name: string): string {
  return `/api/containers/${encodeURIComponent(name)}/logs`;
}

export const containerLogsParamsSchema = z.strictObject({ name: containerNameSchema });
export type ContainerLogsParams = z.infer<typeof containerLogsParamsSchema>;

/** A whole number in a query string: digits only (no sign, no exponent, no spaces). */
const queryInt = z
  .string()
  .regex(/^\d{1,9}$/)
  .transform(Number);

/**
 * The query: the last `tail` lines (or those after `since`), then new ones live. Strict: anything
 * else is a 400. A reconnect's `Last-Event-ID` header takes the place of `since`.
 */
export const containerLogsQuerySchema = z.strictObject({
  tail: queryInt
    .pipe(z.number().min(LOG_LIMITS.minTail).max(LOG_LIMITS.maxTail))
    .default(LOG_LIMITS.defaultTail),
  /** Resuming (a hidden tab shown again): only lines after the last one the viewer has. */
  since: logTimestampSchema.optional(),
});
export type ContainerLogsQuery = z.infer<typeof containerLogsQuerySchema>;

// The events. Each `lines` event's `id` is its last line's `at`: what `EventSource` sends back as
// `Last-Event-ID` when it reconnects.

export const LOGS_EVENTS = { lines: 'lines', end: 'end' } as const;

/** `data` of a `lines` event: as Docker delivered them, oldest first. */
export const logsLinesSchema = z.object({ lines: z.array(logLineSchema).min(1) });
export type LogsLines = z.infer<typeof logsLinesSchema>;

export const LOGS_END_REASONS = [
  /** The container stopped; the history stays. */
  'stopped',
  /** The container was removed while being watched. */
  'removed',
  /** No container with this name (an old link, a typo). */
  'not_found',
  /** Its log driver can't be read back (e.g. `none`, `syslog`). */
  'unavailable',
  /** Docker not reachable, or the stream failed. */
  'error',
  /** Already `LOG_LIMITS.maxStreamsPerSession` log views open in this sign-in. */
  'too_many',
] as const;
export const logsEndReasonSchema = z.enum(LOGS_END_REASONS);
export type LogsEndReason = z.infer<typeof logsEndReasonSchema>;

/** `data` of an `end` event: the stream is over and the browser closes it (no reconnecting). */
export const logsEndSchema = z.object({ reason: logsEndReasonSchema });
export type LogsEnd = z.infer<typeof logsEndSchema>;
