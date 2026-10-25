import type { LinuxSession, PublicUser } from '@laris/shared';
import type { AuditService } from '../audit/audit.service.js';
import type { SystemReader } from '../host/system-reader.js';
import type { RawProcess } from '../host/host.model.js';
import type { LinuxSessions } from '../linux-sessions/linux-sessions.js';
import type { LinuxCommandResult } from '../linux-sessions/linux-sessions.model.js';
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
  let result: LinuxCommandResult;
  let run: ReturnType<typeof vi.fn>;
  let record: ReturnType<typeof vi.fn>;
  let tryRecord: ReturnType<typeof vi.fn>;
  let service: ProcessesService;

  beforeEach(() => {
    found = person;
    linux = { username: 'anna', home: '/home/anna', uid: 1500 };
    result = { code: 0, stdout: '', stderr: '' };
    run = vi.fn(async () => result);
    record = vi.fn(async () => undefined);
    tryRecord = vi.fn(async () => undefined);
    const reader = {
      process: async () => found,
      users: async () => new Map([[1500, 'anna']]),
    } as unknown as SystemReader;
    service = new ProcessesService(
      reader,
      { current: () => linux, run } as unknown as LinuxSessions,
      { record, tryRecord } as unknown as AuditService,
    );
  });

  const signal = (startTicks = '5000', password?: string) =>
    service.signal(SESSION, { pid: 4312, startTicks, signal: 'TERM' }, ACTOR, password);
  const rejection = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: { getStatus(): number; getResponse(): { code: string } }) => [
        error.getStatus(),
        error.getResponse().code,
      ],
    );

  it('ends it as the Linux account: the fixed kill command, nothing on stdin, audited first', async () => {
    await signal();
    expect(run).toHaveBeenCalledWith(SESSION, 'env LC_ALL=C kill -s TERM -- 4312', '');
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

  it('as administrator: through sudo, the password on stdin only — never audited', async () => {
    await signal('5000', 'sudo-pass');
    expect(run).toHaveBeenCalledWith(
      SESSION,
      "env LC_ALL=C sudo -k -S -p '' -- kill -s TERM -- 4312",
      'sudo-pass\n',
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ asAdministrator: true }) }),
    );
    expect(JSON.stringify([record.mock.calls, tryRecord.mock.calls])).not.toContain('sudo-pass');
  });

  it('without a Linux session: 403 linux_session_required, nothing run or recorded', async () => {
    linux = null;
    expect(await rejection(signal())).toEqual([403, 'linux_session_required']);
    expect(run).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('a process gone, or the PID used again: 404, nothing run', async () => {
    expect(await rejection(signal('9999'))).toEqual([404, 'process_not_found']);
    found = null;
    expect(await rejection(signal())).toEqual([404, 'process_not_found']);
    expect(run).not.toHaveBeenCalled();
  });

  it('never PID 1 or a kernel thread: 403, nothing run', async () => {
    found = { ...person, pid: 1 };
    expect(await rejection(signal())).toEqual([403, 'process_protected']);
    found = { ...person, flags: 0x200000 };
    expect(await rejection(signal())).toEqual([403, 'process_protected']);
    expect(run).not.toHaveBeenCalled();
  });

  it('the audit log unavailable: 503, nothing run', async () => {
    record.mockRejectedValueOnce(new Error('no audit table'));
    expect(await rejection(signal())).toEqual([503, 'audit_unavailable']);
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ['kill: (4312) - Operation not permitted', false, 'process_not_permitted'],
    [
      'kill: sending signal to 4312 failed: Operation not permitted',
      false,
      'process_not_permitted',
    ],
    ['kill: (4312) - No such process', false, 'process_not_found'],
    ['something else', false, 'signal_failed'],
    [
      'Sorry, try again.\nsudo: no password was provided\nsudo: 1 incorrect password attempt',
      true,
      'sudo_password_wrong',
    ],
    ['anna is not in the sudoers file.', true, 'sudo_not_allowed'],
    [
      "Sorry, user anna is not allowed to execute '/usr/bin/kill' as root.",
      true,
      'sudo_not_allowed',
    ],
    ['kill: (4312) - No such process', true, 'process_not_found'],
  ])('reads what Linux said: %j → %s', async (stderr, asAdministrator, code) => {
    result = { code: 1, stdout: '', stderr };
    const answer = await rejection(signal('5000', asAdministrator ? 'pw' : undefined));
    expect(answer?.[1]).toBe(code);
    expect(answer?.[0]).not.toBe(401);
    expect(tryRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'failure',
        details: expect.objectContaining({ reason: code }),
      }),
    );
  });

  it('no sudo on the machine (env: 127) is "not allowed"', async () => {
    result = { code: 127, stdout: '', stderr: "env: 'sudo': No such file or directory" };
    expect(await rejection(signal('5000', 'pw'))).toEqual([403, 'sudo_not_allowed']);
  });
});
