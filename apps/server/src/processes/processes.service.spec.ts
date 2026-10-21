import type { PublicUser } from '@laris/shared';
import type { ExecutorService } from '../executor/executor.service.js';
import type { WrapperConfigService } from '../executor/wrapper-config.js';
import type { SystemReader } from '../host/system-reader.js';
import type { RawProcess } from '../host/host.model.js';
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

const person: RawProcess = {
  pid: 4312,
  name: 'python3',
  state: 'R',
  flags: 0,
  cpuTicks: 0,
  startTicks: '5000',
  uids: [1500, 1500, 1500, 1500],
  rssBytes: 0,
  command: 'python3 --token=secret',
  containerId: null,
};

describe('ProcessesService', () => {
  let found: RawProcess | null;
  let processSignal: ReturnType<typeof vi.fn>;
  let service: ProcessesService;

  beforeEach(() => {
    found = person;
    processSignal = vi.fn(async () => ({ ok: true }));
    const reader = {
      process: async () => found,
      users: async () => new Map([[1500, 'anna']]),
    } as unknown as SystemReader;
    const wrapperConfig = {
      config: { process: { appUid: 990 } },
    } as unknown as WrapperConfigService;
    service = new ProcessesService(
      reader,
      { processSignal } as unknown as ExecutorService,
      wrapperConfig,
    );
  });

  const signal = (startTicks = '5000') =>
    service.signal({ pid: 4312, startTicks, signal: 'TERM' }, ACTOR);
  const rejection = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: { getStatus(): number; getResponse(): { code: string } }) => [
        error.getStatus(),
        error.getResponse().code,
      ],
    );

  it('ends a person’s process through the executor, named without its command line', async () => {
    await signal();
    expect(processSignal).toHaveBeenCalledWith(
      { pid: 4312, startTicks: '5000', signal: 'TERM' },
      { name: 'python3', user: 'anna' },
      ACTOR,
    );
  });

  it('a process gone, or the PID used again: 404, nothing run', async () => {
    expect(await rejection(signal('9999'))).toEqual([404, 'process_not_found']);
    found = null;
    expect(await rejection(signal())).toEqual([404, 'process_not_found']);
    expect(processSignal).not.toHaveBeenCalled();
  });

  it('not a person’s process: 403, nothing run', async () => {
    found = { ...person, uids: [0, 0, 0, 0] };
    expect(await rejection(signal())).toEqual([403, 'process_protected']);
    found = { ...person, containerId: 'c'.repeat(64) };
    expect(await rejection(signal())).toEqual([403, 'process_protected']);
    expect(processSignal).not.toHaveBeenCalled();
  });

  it('passes on the wrapper’s answer; the audit log unavailable is 503', async () => {
    processSignal.mockResolvedValueOnce({ ok: false, code: 'process_not_found' });
    expect(await rejection(signal())).toEqual([404, 'process_not_found']);
    processSignal.mockRejectedValueOnce(new Error('no audit table'));
    expect(await rejection(signal())).toEqual([503, 'audit_unavailable']);
  });
});
