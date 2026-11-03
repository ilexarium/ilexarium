// The machine's journal (docs/plans/system_logs.md), read as this account — journald decides what
// it sees — or by laris-root for `administrator`. Only journalctl's JSON, a fixed set of fields
// from each entry; every value it's given checked and passed as one argument.

import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { BAD_REQUEST, ok, refused, type Answer, type Request } from './answers.mts';
import {
  BOOT_ID_PATTERN,
  BOOTS_MAX,
  CURSOR_PATTERN,
  GROUP_FILE,
  JOURNAL_ANSWER_MAX,
  JOURNAL_ENTRY_MAX,
  JOURNAL_FIELDS,
  JOURNAL_GROUPS,
  JOURNAL_LINES_MAX,
  JOURNAL_MESSAGE_MAX,
  PROGRAMS,
  QUICK_TIMEOUT_MS,
  SERVICE_PATTERN,
  UNIT_TEXT_MAX,
  UNITS_OUTPUT_MAX,
} from './config.mts';
import { run, runLines } from './run.mts';

const BASE = ['--no-pager', '--quiet', '--output=json'];

let access: 'all' | 'own' | null = null;

/**
 * journald's groups by their IDs: in one of them, the account reads everything. Worked out once:
 * a process's groups don't change.
 */
export function journalAccess(): 'all' | 'own' {
  access ??= readAccess();
  return access;
}

function readAccess(): 'all' | 'own' {
  if (process.getuid?.() === 0) return 'all';
  let groups: string;
  try {
    groups = readFileSync(GROUP_FILE, 'utf8');
  } catch {
    return 'own';
  }
  const mine = new Set(process.getgroups?.() ?? []);
  for (const line of groups.split('\n')) {
    const [name, , gid] = line.split(':');
    if (JOURNAL_GROUPS.includes(name ?? '') && /^\d+$/.test(gid ?? '') && mine.has(Number(gid))) {
      return 'all';
    }
  }
  return 'own';
}

/** A field's value: text, or bytes that aren't UTF-8 (an array of numbers); repeated: the first. */
function value(field: unknown, repeated = true): string | null {
  if (typeof field === 'string') return field;
  if (!Array.isArray(field)) return null;
  if (field.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    return Buffer.from(field as number[]).toString('utf8');
  }
  return repeated ? value(field[0], false) : null;
}

/** Cut at `max` bytes, never inside a character. */
function cut(text: string, max: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text);
  if (bytes.length <= max) return { text, truncated: false };
  return { text: bytes.subarray(0, max).toString('utf8').replace(/�$/, ''), truncated: true };
}

/** One entry, only its known fields; null if it isn't one (no cursor or time). */
function line(output: string): Record<string, unknown> | null {
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(output) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!entry || typeof entry !== 'object') return null;
  const cursor = entry['__CURSOR'];
  const time = entry['__REALTIME_TIMESTAMP'];
  if (typeof cursor !== 'string' || !CURSOR_PATTERN.test(cursor)) return null;
  if (typeof time !== 'string' || !/^\d{1,20}$/.test(time)) return null;
  const short = (field: unknown) => value(field)?.slice(0, UNIT_TEXT_MAX) ?? null;
  const message = cut(value(entry['MESSAGE']) ?? '', JOURNAL_MESSAGE_MAX);
  return {
    cursor,
    time,
    priority: short(entry['PRIORITY']),
    unit: short(entry['_SYSTEMD_UNIT']),
    identifier: short(entry['SYSLOG_IDENTIFIER']),
    pid: short(entry['_PID']),
    message: message.text,
    ...(message.truncated && { truncated: true }),
  };
}

/** `boot`: an ID, or 0 (this boot) / -1 (the previous one) when the boots can't be listed. */
function bootArgument(boot: unknown): string | null {
  if (boot === 0 || boot === -1) return `--boot=${boot}`;
  if (typeof boot === 'string' && BOOT_ID_PATTERN.test(boot)) return `--boot=${boot}`;
  return null;
}

/**
 * Up to JOURNAL_LINES_MAX lines, oldest first: the newest, those after a cursor, or those before
 * one. Read from where it starts and stopped once the answer is full, so a huge journal costs
 * only what's sent; `more`: it stopped before the end.
 */
export async function readJournal(request: Request): Promise<Answer> {
  const { unit, priority, boot, after, before, administrator } = request;
  if (typeof administrator !== 'boolean') return BAD_REQUEST;
  if (unit !== undefined && (typeof unit !== 'string' || !SERVICE_PATTERN.test(unit))) {
    return BAD_REQUEST;
  }
  if (typeof priority !== 'number' || !Number.isInteger(priority) || priority < 0 || priority > 7) {
    return BAD_REQUEST;
  }
  const cursor = (c: unknown) =>
    c === undefined || (typeof c === 'string' && CURSOR_PATTERN.test(c));
  if (!cursor(after) || !cursor(before) || (after && before)) return BAD_REQUEST;
  const bootArg = bootArgument(boot);
  if (!bootArg) return BAD_REQUEST;

  const forward = typeof after === 'string';
  const args = [
    ...BASE,
    '--all',
    `--output-fields=${JOURNAL_FIELDS.join(',')}`,
    bootArg,
    ...(priority < 7 ? [`--priority=${priority}`] : []),
    ...(typeof unit === 'string' ? [`--unit=${unit}`] : []),
    // The cursor's own entry comes first when reading back from it: one more to skip.
    `--lines=${JOURNAL_LINES_MAX + (typeof before === 'string' ? 2 : 1)}`,
    ...(forward ? [`--after-cursor=${after}`] : []),
    ...(typeof before === 'string' ? [`--cursor=${before}`] : []),
    ...(forward ? [] : ['--reverse']),
  ];
  const lines: Record<string, unknown>[] = [];
  let size = 0;
  let more = false;
  const result = await runLines(
    PROGRAMS.journalctl,
    args,
    { timeoutMs: QUICK_TIMEOUT_MS, lineMax: JOURNAL_ENTRY_MAX },
    (output) => {
      const entry = line(output);
      if (!entry || entry['cursor'] === before) return true;
      // Bytes, as the server counts them: messages may be in any language.
      const bytes = Buffer.byteLength(JSON.stringify(entry)) + 1;
      if (lines.length === JOURNAL_LINES_MAX || size + bytes > JOURNAL_ANSWER_MAX) {
        more = true;
        return false;
      }
      size += bytes;
      lines.push(entry);
      return true;
    },
  );
  if (result.timedOut) return refused('timed_out');
  if (result.missing) return refused('unavailable');
  // journalctl's refusals (an unknown boot, a cursor it can't find) say nothing we pass on.
  if (!result.stopped && result.code !== 0) return refused('failed');
  return ok({ lines: forward ? lines : lines.reverse(), more, access: journalAccess() });
}

/** Every boot the journal still holds, newest first; null when journalctl can't say it as JSON. */
export async function listBoots(request: Request): Promise<Answer> {
  if (typeof request['administrator'] !== 'boolean') return BAD_REQUEST;
  const result = await run(PROGRAMS.journalctl, [...BASE, '--list-boots'], {
    timeoutMs: QUICK_TIMEOUT_MS,
    outputMax: UNITS_OUTPUT_MAX,
  });
  if (result.timedOut) return refused('timed_out');
  if (result.missing) return refused('unavailable');
  if (result.code !== 0) return refused('failed');
  let listed: unknown;
  try {
    listed = JSON.parse(result.stdout);
  } catch {
    return ok({ boots: null, access: journalAccess() });
  }
  if (!Array.isArray(listed)) return ok({ boots: null, access: journalAccess() });
  const boots = listed
    .filter((boot): boot is Record<string, unknown> => !!boot && typeof boot === 'object')
    .map((boot) => ({
      id: boot['boot_id'],
      offset: boot['index'],
      first: boot['first_entry'],
      last: boot['last_entry'],
    }))
    .filter(
      (boot) =>
        typeof boot.id === 'string' &&
        BOOT_ID_PATTERN.test(boot.id) &&
        Number.isSafeInteger(boot.offset) &&
        Number.isSafeInteger(boot.first) &&
        Number.isSafeInteger(boot.last),
    )
    .reverse()
    .slice(0, BOOTS_MAX);
  return ok({ boots, access: journalAccess() });
}
