import { HttpException } from '@nestjs/common';
import type { LinuxSession, PublicUser } from '@ilex/shared';
import type { AuditService } from '../audit/audit.service.js';
import type { SystemReader } from '../host/system-reader.js';
import type { RawProcess } from '../host/host.model.js';
import type { LinuxSessions } from '../linux-sessions/linux-sessions.js';
import type { HelperAnswer } from '../linux-sessions/linux-sessions.model.js';
import { ProcessesService } from './processes.service.js';

const USER: PublicUser = {
  id: 'u1',
  username: 'owner',
  createdAt: '2026-10-12T00:00:00.000Z',
  displayName: null,
  email: null,
  language: null,
  avatar: null,
};
const ACTOR = { user: USER, ip: '127.0.0.1' };
const SESSION = 'app-session';

const person: RawProcess = {
  pid: 4312,
  name: 'python3',
  state: 'R',
  flags: 0,
  cpuTicks: 0,
  priority: 20,
  nice: 0,
  startTicks: '5000',
  virtualBytes: 0,
  uids: [1500, 1500, 1500, 1500],
  rssBytes: 0,
  sharedBytes: 0,
  command: 'python3 --token=secret',
  containerId: null,
};

describe('ProcessesService', () => {
  let found: RawProcess | null;
  let linux: LinuxSession | null;
  let answer: HelperAnswer;
  let ask: ReturnType<typeof vi.fn>;
  let record: ReturnType<typeof vi.fn>;
  let tryRecord: ReturnType<typeof vi.fn>;
  let service: ProcessesService;

  beforeEach(() => {
    found = person;
    linux = { username: 'anna', home: '/home/anna', uid: 1500, sudoUntil: null };
    answer = { ok: true };
    ask = vi.fn(async () => answer);
    record = vi.fn(async () => undefined);
    tryRecord = vi.fn(async () => undefined);
    const reader = {
      process: async () => found,
      users: async () => new Map([[1500, 'anna']]),
    } as unknown as SystemReader;
    service = new ProcessesService(
      reader,
      { current: () => linux, ask } as unknown as LinuxSessions,
      { record, tryRecord } as unknown as AuditService,
    );
  });

  const signal = (startTicks = '5000') =>
    service.signal(SESSION, { pid: 4312, startTicks, signal: 'TERM' }, ACTOR);
  /** Another account's process: ended through sudo. */
  const others = () => (found = { ...person, uids: [0, 0, 0, 0] });
  const rejection = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: { getStatus(): number; getResponse(): { code: string } }) => [
        error.getStatus(),
        error.getResponse().code,
      ],
    );

  it('ends its own process as the Linux account, through the helper, audited first', async () => {
    await signal();
    expect(ask).toHaveBeenCalledWith(
      SESSION,
      { action: 'process.signal', pid: 4312, signal: 'TERM', administrator: false },
      { sudo: false },
    );
    const details = {
      pid: 4312,
      name: 'python3',
      user: 'anna',
      signal: 'TERM',
      linuxUser: 'anna',
      asAdministrator: false,
    };
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'process.end', outcome: 'requested', details }),
    );
    expect(tryRecord).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'success', details }),
    );
    // Never the command line.
    expect(JSON.stringify([record.mock.calls, tryRecord.mock.calls])).not.toContain('secret');
  });

  it('another account’s process: through the account’s sudo', async () => {
    others();
    await signal();
    expect(ask).toHaveBeenCalledWith(
      SESSION,
      { action: 'process.signal', pid: 4312, signal: 'TERM', administrator: true },
      { sudo: true },
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ asAdministrator: true }) }),
    );
  });

  it('an account whose uid is unknown tries as itself', async () => {
    linux = { ...linux!, uid: null };
    others();
    await signal();
    expect(ask).toHaveBeenCalledWith(SESSION, expect.objectContaining({ administrator: false }), {
      sudo: false,
    });
  });

  it('without a Linux session: 403 linux_session_required, nothing run or recorded', async () => {
    linux = null;
    expect(await rejection(signal())).toEqual([403, 'linux_session_required']);
    expect(ask).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('a process gone, or the PID used again: 404, nothing run', async () => {
    expect(await rejection(signal('9999'))).toEqual([404, 'process_not_found']);
    found = null;
    expect(await rejection(signal())).toEqual([404, 'process_not_found']);
    expect(ask).not.toHaveBeenCalled();
  });

  it('never PID 1 or a kernel thread: 403, nothing run', async () => {
    found = { ...person, pid: 1 };
    expect(await rejection(signal())).toEqual([403, 'process_protected']);
    found = { ...person, flags: 0x200000 };
    expect(await rejection(signal())).toEqual([403, 'process_protected']);
    expect(ask).not.toHaveBeenCalled();
  });

  it('the audit log unavailable: 503, nothing run', async () => {
    record.mockRejectedValueOnce(new Error('no audit table'));
    expect(await rejection(signal())).toEqual([503, 'audit_unavailable']);
    expect(ask).not.toHaveBeenCalled();
  });

  it.each([
    ['not_permitted', 403, 'process_not_permitted'],
    ['not_found', 404, 'process_not_found'],
    ['timed_out', 504, 'timed_out'],
    ['failed', 502, 'signal_failed'],
    ['something new', 502, 'signal_failed'],
    ['sudo_required', 403, 'sudo_required'],
    ['sudo_not_allowed', 403, 'sudo_not_allowed'],
    ['sudo_unavailable', 403, 'sudo_not_allowed'],
    ['ended', 503, 'helper_unavailable'],
  ])('reads what the helper said: %s → %i %s', async (error, status, code) => {
    answer = { ok: false, error };
    expect(await rejection(signal())).toEqual([status, code]);
    expect(tryRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'failure',
        details: expect.objectContaining({ reason: code }),
      }),
    );
  });

  it('the Linux session gone meanwhile: audited with its own code, passed on', async () => {
    ask.mockRejectedValueOnce(
      new HttpException({ message: 'x', code: 'linux_session_required' }, 403),
    );
    expect(await rejection(signal())).toEqual([403, 'linux_session_required']);
    expect(tryRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'failure',
        details: expect.objectContaining({ reason: 'linux_session_required' }),
      }),
    );
  });
});
