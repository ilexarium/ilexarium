import { HttpStatus } from '@nestjs/common';
import { FILES_ERROR_CODES, type FilesErrorCode, JOURNAL_ERROR_CODES } from '@laris/shared';
import { z } from 'zod';
import { ANSI } from '../docker/log-lines.constants.js';

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

const digits = (max: number) => z.string().regex(new RegExp(`^\\d{1,${max}}$`));

/** `journal.read`'s answer (system/programs/helper/journal.mts): journald's fields as text. */
export const helperJournalSchema = z.object({
  lines: z.array(
    z.object({
      cursor: z.string(),
      /** Microseconds since 1970. */
      time: digits(20),
      priority: z.string().nullable(),
      unit: z.string().nullable(),
      identifier: z.string().nullable(),
      pid: z.string().nullable(),
      message: z.string(),
      truncated: z.literal(true).optional(),
    }),
  ),
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
        first: z.number().int().nonnegative(),
        last: z.number().int().nonnegative(),
      }),
    )
    .nullable(),
  access: z.enum(['all', 'own']),
});

/** Escapes and control characters, except line breaks and tabs: a message may span lines. */
export const ESCAPES = new RegExp(ANSI, 'g');
// oxlint-disable-next-line no-control-regex
export const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
