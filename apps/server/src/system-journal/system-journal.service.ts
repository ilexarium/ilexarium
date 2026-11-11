import { HttpException, Injectable } from '@nestjs/common';
import {
  type ApiErrorResponse,
  JOURNAL_PRIORITIES,
  type JournalBootsResponse,
  type JournalLine,
  type JournalQuery,
  type JournalResponse,
} from '@ilex/shared';
import { linuxError } from '../linux-sessions/linux-session-errors.js';
import { LinuxSessions } from '../linux-sessions/linux-sessions.js';
import type { HelperAnswer } from '../linux-sessions/linux-sessions.model.js';
import { stripAnsi } from '../docker/log-lines.js';
import {
  HELPER_ERRORS,
  helperBootsSchema,
  helperJournalSchema,
  helperLineSchema,
  READ_TIMEOUT_MS,
  UNAVAILABLE,
  UNAVAILABLE_STATUS,
} from './system-journal.constants.js';

function unavailable(): HttpException {
  const body: ApiErrorResponse = { message: 'The journal could not be read', code: UNAVAILABLE };
  return new HttpException(body, UNAVAILABLE_STATUS);
}

/** A read the helper refused: sudo's or the Linux session's trouble, or journalctl's. */
function readFailure(answer: HelperAnswer & { ok: false }): HttpException {
  const code = HELPER_ERRORS[answer.error];
  return code ? linuxError(code, 'The journal could not be read') : unavailable();
}

const iso = (microseconds: number) => new Date(Math.floor(microseconds / 1000)).toISOString();
/** A name as the journal has it (anyone can log under any identifier): plain, or none. */
const name = (value: string | null) => (value ? stripAnsi(value) || null : null);

const smallInt = (value: string | null, min: number, max: number) => {
  if (value === null || !/^\d{1,7}$/.test(value)) return null;
  const n = Number(value);
  return n >= min && n <= max ? n : null;
};

/**
 * The machine's journal, read as the signed-in Linux account through
 * its helper — journald decides what it sees —, or as administrator through its unlocked sudo.
 * Not audited (like container logs); messages are never logged here.
 */
@Injectable()
export class SystemJournalService {
  constructor(private readonly linuxSessions: LinuxSessions) {}

  async read(appSessionId: string, query: JournalQuery): Promise<JournalResponse> {
    const administrator = query.administrator ?? false;
    const answer = await this.linuxSessions.ask(
      appSessionId,
      {
        action: 'journal.read',
        priority: JOURNAL_PRIORITIES[query.priority],
        boot: query.boot === undefined ? 0 : query.boot === '-1' ? -1 : query.boot,
        administrator,
        ...(query.unit && { unit: query.unit }),
        ...(query.after && { after: query.after }),
        ...(query.before && { before: query.before }),
      },
      { sudo: administrator, timeoutMs: READ_TIMEOUT_MS },
    );
    if (!answer.ok) throw readFailure(answer);
    const parsed = helperJournalSchema.safeParse(answer);
    if (!parsed.success) throw unavailable();
    return {
      lines: parsed.data.lines.flatMap((entry): JournalLine[] => {
        const line = helperLineSchema.safeParse(entry).data;
        if (!line) return [];
        return [
          {
            cursor: line.cursor,
            at: iso(Number(line.time)),
            priority: smallInt(line.priority, 0, 7),
            unit: name(line.unit),
            identifier: name(line.identifier),
            pid: smallInt(line.pid, 1, 4_194_304),
            text: stripAnsi(line.message, { keepLineBreaks: true }),
            ...(line.truncated && { truncated: true }),
          },
        ];
      }),
      more: parsed.data.more,
      access: parsed.data.access,
    };
  }

  async boots(appSessionId: string, administrator: boolean): Promise<JournalBootsResponse> {
    const answer = await this.linuxSessions.ask(
      appSessionId,
      { action: 'journal.boots', administrator },
      { sudo: administrator, timeoutMs: READ_TIMEOUT_MS },
    );
    if (!answer.ok) throw readFailure(answer);
    const parsed = helperBootsSchema.safeParse(answer);
    if (!parsed.success) throw unavailable();
    return {
      boots:
        parsed.data.boots?.map((boot) => ({
          id: boot.id,
          offset: boot.offset,
          first: iso(boot.first),
          last: iso(boot.last),
        })) ?? null,
      access: parsed.data.access,
    };
  }
}
