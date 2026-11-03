import type { HelperAnswer } from '../linux-sessions/linux-sessions.model.js';
import type { LinuxSessions } from '../linux-sessions/linux-sessions.js';
import { SystemJournalService } from './system-journal.service.js';

const SESSION = 'app-session';
const CURSOR = 's=abc;i=1;b=f00d;m=1;t=2;x=3';

const helperLine = (overrides: Record<string, unknown> = {}) => ({
  cursor: CURSOR,
  time: '1792573340123456',
  priority: '3',
  unit: 'nginx.service',
  identifier: 'nginx',
  pid: '452',
  message: 'failed',
  ...overrides,
});

describe('SystemJournalService', () => {
  let answer: HelperAnswer;
  let ask: ReturnType<typeof vi.fn>;
  let service: SystemJournalService;

  beforeEach(() => {
    answer = { ok: true, lines: [helperLine()], more: false, access: 'all' };
    ask = vi.fn(async () => answer);
    service = new SystemJournalService({ ask } as unknown as LinuxSessions);
  });

  const rejection = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: { getStatus(): number; getResponse(): { code: string } }) => [
        error.getStatus(),
        error.getResponse().code,
      ],
    );

  it('reads as the account: this boot, the priority as journald’s number, times as ISO', async () => {
    expect(await service.read(SESSION, { priority: 'info' })).toEqual({
      lines: [
        {
          cursor: CURSOR,
          at: '2026-10-21T09:02:20.123Z',
          priority: 3,
          unit: 'nginx.service',
          identifier: 'nginx',
          pid: 452,
          text: 'failed',
        },
      ],
      more: false,
      access: 'all',
    });
    expect(ask).toHaveBeenCalledWith(
      SESSION,
      { action: 'journal.read', priority: 6, boot: 0, administrator: false },
      { sudo: false, timeoutMs: 35_000 },
    );
  });

  it('passes the filters and the cursor on; as administrator, through sudo', async () => {
    await service.read(SESSION, {
      priority: 'debug',
      unit: 'nginx.service',
      boot: '-1',
      before: CURSOR,
      administrator: true,
    });
    expect(ask).toHaveBeenLastCalledWith(
      SESSION,
      {
        action: 'journal.read',
        priority: 7,
        boot: -1,
        unit: 'nginx.service',
        before: CURSOR,
        administrator: true,
      },
      { sudo: true, timeoutMs: 35_000 },
    );
    await service.read(SESSION, { priority: 'error', boot: 'a'.repeat(32), after: CURSOR });
    expect(ask.mock.calls.at(-1)?.[1]).toMatchObject({ boot: 'a'.repeat(32), after: CURSOR });
  });

  it('plain text: escapes and control characters gone, line breaks and tabs kept; odd numbers null', async () => {
    answer = {
      ok: true,
      lines: [
        helperLine({
          message: '\x1b[31mred\x1b[0m\tand\nnext\x07\x00',
          priority: '9',
          pid: '0',
          unit: null,
          identifier: '',
          truncated: true,
        }),
      ],
      more: true,
      access: 'own',
    };
    const read = await service.read(SESSION, { priority: 'info' });
    expect(read.lines[0]).toMatchObject({
      text: 'red\tand\nnext',
      priority: null,
      pid: null,
      unit: null,
      identifier: null,
      truncated: true,
    });
    expect(read).toMatchObject({ more: true, access: 'own' });
  });

  it('a locked sudo is the usual 403; journalctl’s trouble or an odd answer: unavailable', async () => {
    answer = { ok: false, error: 'sudo_required' };
    expect(
      await rejection(service.read(SESSION, { priority: 'info', administrator: true })),
    ).toEqual([403, 'sudo_required']);
    for (const refused of ['failed', 'timed_out', 'unavailable']) {
      answer = { ok: false, error: refused };
      expect(await rejection(service.read(SESSION, { priority: 'info' }))).toEqual([
        503,
        'journal_unavailable',
      ]);
    }
    answer = { ok: true, lines: 'many', more: false, access: 'all' };
    expect(await rejection(service.read(SESSION, { priority: 'info' }))).toEqual([
      503,
      'journal_unavailable',
    ]);
  });

  it('an odd line is left out, not the whole answer (a time no date can hold, no cursor)', async () => {
    answer = {
      ok: true,
      lines: [
        helperLine({ time: 'soon' }),
        helperLine({ time: '99999999999999999999' }),
        { message: 'no cursor' },
        helperLine({ cursor: 'kept', identifier: '\x1b[31mevil\x07', unit: '\x07' }),
      ],
      more: false,
      access: 'all',
    };
    const read = await service.read(SESSION, { priority: 'info' });
    expect(read.lines).toHaveLength(1);
    // Anyone can log under any name: plain text too.
    expect(read.lines[0]).toMatchObject({ cursor: 'kept', identifier: 'evil', unit: null });
  });

  it('lists the boots with their times; none when journalctl can’t say them', async () => {
    answer = {
      ok: true,
      boots: [{ id: 'b'.repeat(32), offset: 0, first: 1792573340000000, last: 1792573400000000 }],
      access: 'own',
    };
    expect(await service.boots(SESSION, false)).toEqual({
      boots: [
        {
          id: 'b'.repeat(32),
          offset: 0,
          first: '2026-10-21T09:02:20.000Z',
          last: '2026-10-21T09:03:20.000Z',
        },
      ],
      access: 'own',
    });
    expect(ask).toHaveBeenLastCalledWith(
      SESSION,
      { action: 'journal.boots', administrator: false },
      { sudo: false, timeoutMs: 35_000 },
    );
    answer = { ok: true, boots: [{ id: 'x', offset: 0, first: 1e19, last: 1e19 }], access: 'all' };
    expect(await rejection(service.boots(SESSION, false))).toEqual([503, 'journal_unavailable']);
    answer = { ok: true, boots: null, access: 'all' };
    expect(await service.boots(SESSION, true)).toEqual({ boots: null, access: 'all' });
    expect(ask.mock.calls.at(-1)?.[2]).toEqual({ sudo: true, timeoutMs: 35_000 });
  });
});
