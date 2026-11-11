import { z } from 'zod';
import { systemServiceNameSchema } from './system-services.js';

/**
 * The machine's journal: read as the signed-in Linux account through
 * its helper — journald decides what it sees —, or through its unlocked sudo as administrator.
 * Read by asking with the journal's cursor: what's newer than the last line, or older than the
 * first.
 */

export const JOURNAL_LIMITS = {
  /** Lines in one answer at most (fewer when they're long: the answer's size is capped too). */
  linesPerRead: 500,
  /** A longer message is cut and marked `truncated`. */
  maxMessageBytes: 16 * 1024,
  /** Newer lines are asked for this often while the page is shown. */
  pollMs: 2000,
  /** Lines the page keeps; "Load older" stops there. */
  maxLinesInView: 10_000,
} as const;

/**
 * journald's cursor (`s=…;i=…;b=…;m=…;t=…;x=…`), opaque: passed back as one argument. The helper
 * checks the same (rules-match-app.spec.ts).
 */
export const JOURNAL_CURSOR_PATTERN = /^[A-Za-z0-9=;_-]{1,512}$/;
export const journalCursorSchema = z.string().regex(JOURNAL_CURSOR_PATTERN);

/** A boot's ID as journald writes it (128 bits in hex). */
export const JOURNAL_BOOT_ID_PATTERN = /^[0-9a-f]{32}$/;
/**
 * A boot: its ID, or `-1` — the previous one, when this journalctl can't list them as JSON.
 * Without one: this boot.
 */
export const journalBootSchema = z.union([
  z.string().regex(JOURNAL_BOOT_ID_PATTERN),
  z.literal('-1'),
]);

/** How much is shown: journald's priorities, this one and the more urgent ones. */
export const JOURNAL_PRIORITIES = {
  error: 3,
  warning: 4,
  info: 6,
  debug: 7,
} as const;
export type JournalPriority = keyof typeof JOURNAL_PRIORITIES;
export const journalPrioritySchema = z.enum(
  Object.keys(JOURNAL_PRIORITIES) as [JournalPriority, ...JournalPriority[]],
);

export const journalLineSchema = z.object({
  cursor: journalCursorSchema,
  /** When it was logged (journald's wall-clock time). */
  at: z.iso.datetime(),
  /** 0 (emergency) to 7 (debug); null when the message has none. */
  priority: z.number().int().min(0).max(7).nullable(),
  /** The unit it came from (`nginx.service`), if any. */
  unit: z.string().nullable(),
  /** The program's own name for itself (`SYSLOG_IDENTIFIER`), if any. */
  identifier: z.string().nullable(),
  pid: z.number().int().positive().nullable(),
  /** Plain text. May contain secrets — always render as text. */
  text: z.string(),
  /** The message was longer than `JOURNAL_LIMITS.maxMessageBytes` and was cut. */
  truncated: z.literal(true).optional(),
});
export type JournalLine = z.infer<typeof journalLineSchema>;

/** Everything (`all`), or only the account's own messages: it's in neither journal group. */
export const JOURNAL_ACCESS = ['all', 'own'] as const;
export const journalAccessSchema = z.enum(JOURNAL_ACCESS);
export type JournalAccess = z.infer<typeof journalAccessSchema>;

const queryFlag = z.literal('true').transform(() => true);

/**
 * `GET /api/system/journal`: the newest lines, or those after a cursor (`after`) or before one
 * (`before`). Strict: anything else is a 400.
 */
export const journalQuerySchema = z
  .strictObject({
    unit: systemServiceNameSchema.optional(),
    priority: journalPrioritySchema.default('info'),
    boot: journalBootSchema.optional(),
    after: journalCursorSchema.optional(),
    before: journalCursorSchema.optional(),
    /** Through the account's sudo (403 `sudo_required` while it's locked). */
    administrator: queryFlag.optional(),
  })
  .refine((query) => !(query.after && query.before), { message: 'after or before, not both' });
export type JournalQuery = z.infer<typeof journalQuerySchema>;

export const journalResponseSchema = z.object({
  /** Oldest first. */
  lines: z.array(journalLineSchema),
  /**
   * There's more this way: older lines (the newest or `before`), or newer ones not sent yet
   * (`after`: ask again at once).
   */
  more: z.boolean(),
  access: journalAccessSchema,
});
export type JournalResponse = z.infer<typeof journalResponseSchema>;

/** `GET /api/system/journal/boots`: query `administrator` only. */
export const journalBootsQuerySchema = z.strictObject({ administrator: queryFlag.optional() });
export type JournalBootsQuery = z.infer<typeof journalBootsQuerySchema>;

export const journalBootInfoSchema = z.object({
  id: z.string().regex(JOURNAL_BOOT_ID_PATTERN),
  /** 0 this boot, -1 the one before, … */
  offset: z.number().int().max(0),
  first: z.iso.datetime(),
  last: z.iso.datetime(),
});
export type JournalBootInfo = z.infer<typeof journalBootInfoSchema>;

export const journalBootsResponseSchema = z.object({
  /** Newest first; null when this journalctl can't list them (this boot and the previous one). */
  boots: z.array(journalBootInfoSchema).nullable(),
  access: journalAccessSchema,
});
export type JournalBootsResponse = z.infer<typeof journalBootsResponseSchema>;

export const JOURNAL_ERROR_CODES = {
  /** journalctl couldn't be asked (missing, no answer, or an answer it couldn't read). */
  unavailable: 'journal_unavailable',
} as const;
export type JournalErrorCode = (typeof JOURNAL_ERROR_CODES)[keyof typeof JOURNAL_ERROR_CODES];
