import { z } from 'zod';

export const LOG_LIMITS = {
  /** Open log streams per WebSocket connection. */
  maxStreamsPerConnection: 3,
  /** Lines of history sent first, before following. */
  minTail: 1,
  maxTail: 5000,
  defaultTail: 500,
  /** Longer lines are cut and marked `truncated`. */
  maxLineBytes: 16 * 1024,
  /** Lines are sent at most this often per stream. */
  batchIntervalMs: 250,
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

// Client → server. Strict: anything else is an `invalid_message`.

/** `data` of `logs:open`: the last `tail` lines (or those after `since`), then new ones live. */
export const logsOpenSchema = z.strictObject({
  container: containerNameSchema,
  tail: z
    .number()
    .int()
    .min(LOG_LIMITS.minTail)
    .max(LOG_LIMITS.maxTail)
    .default(LOG_LIMITS.defaultTail),
  /** Resuming after a dropped connection: only lines after the last one the viewer has. */
  since: logTimestampSchema.optional(),
});
export type LogsOpen = z.infer<typeof logsOpenSchema>;

/** `data` of `logs:close`. */
export const logsCloseSchema = z.strictObject({ container: containerNameSchema });
export type LogsClose = z.infer<typeof logsCloseSchema>;

// Server → client.

/** `data` of `logs:lines`: a batch, oldest first. */
export const logsLinesSchema = z.object({
  container: z.string(),
  lines: z.array(logLineSchema),
  /** A flood: this many lines after the last one in `lines` were dropped. */
  skipped: z.number().int().positive().optional(),
});
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
] as const;
export const logsEndReasonSchema = z.enum(LOGS_END_REASONS);
export type LogsEndReason = z.infer<typeof logsEndReasonSchema>;

/** `data` of `logs:end`: the stream is over; no more lines for this container until reopened. */
export const logsEndSchema = z.object({
  container: z.string(),
  reason: logsEndReasonSchema,
});
export type LogsEnd = z.infer<typeof logsEndSchema>;
