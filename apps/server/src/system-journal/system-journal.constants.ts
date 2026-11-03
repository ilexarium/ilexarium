import { HttpStatus } from '@nestjs/common';
import { FILES_ERROR_CODES, type FilesErrorCode, JOURNAL_ERROR_CODES } from '@laris/shared';
import { z } from 'zod';

/** Above the helper's own 30 s for journalctl. */
export const READ_TIMEOUT_MS = 35_000;

/** The helper's refusals, as the API says them (sudo's: the Linux session's). */
export const HELPER_ERRORS: Record<string, FilesErrorCode> = {
  sudo_required: FILES_ERROR_CODES.sudoRequired,
  sudo_not_allowed: FILES_ERROR_CODES.sudoNotAllowed,
  sudo_unavailable: FILES_ERROR_CODES.sudoNotAllowed,
  ended: FILES_ERROR_CODES.helperUnavailable,
};

export const UNAVAILABLE_STATUS = HttpStatus.SERVICE_UNAVAILABLE;
export const UNAVAILABLE = JOURNAL_ERROR_CODES.unavailable;

/** Microseconds since 1970 up to the year 2255 (16 digits): safe as numbers and as dates. */
export const MICROSECONDS_MAX = 9_000_000_000_000_000;

const digits = (max: number) => z.string().regex(new RegExp(`^\\d{1,${max}}$`));

/** A line of `journal.read`'s answer (system/programs/helper/journal.mts): journald's fields as text. */
export const helperLineSchema = z.object({
  cursor: z.string(),
  /** Microseconds since 1970. */
  time: digits(16),
  priority: z.string().nullable(),
  unit: z.string().nullable(),
  identifier: z.string().nullable(),
  pid: z.string().nullable(),
  message: z.string(),
  truncated: z.literal(true).optional(),
});

/** Its lines are checked one by one: an odd one is left out, not the whole answer. */
export const helperJournalSchema = z.object({
  lines: z.array(z.unknown()),
  more: z.boolean(),
  access: z.enum(['all', 'own']),
});

/** `journal.boots`' answer: times in microseconds. */
export const helperBootsSchema = z.object({
  boots: z
    .array(
      z.object({
        id: z.string(),
        offset: z.number().int(),
        first: z.number().int().nonnegative().max(MICROSECONDS_MAX),
        last: z.number().int().nonnegative().max(MICROSECONDS_MAX),
      }),
    )
    .nullable(),
  access: z.enum(['all', 'own']),
});
