import type { RawProcess } from '../host/host.model.js';
import { processKey } from '@laris/shared';
import { isEndable, toProcess } from './process-view.js';
import type { ProcessContext } from './processes.model.js';

const APP = 990;
const ID = 'b'.repeat(64);

const raw = (change: Partial<RawProcess> = {}): RawProcess => ({
  pid: 4312,
  name: 'python3',
  state: 'R',
  flags: 0x400000,
  cpuTicks: 1_000,
  startTicks: '50000',
  uids: [1000, 1000, 1000, 1000],
  rssBytes: 512 * 1024 * 1024,
  command: 'python3 train.py',
  containerId: null,
  ...change,
});

const context = (change: Partial<ProcessContext> = {}): ProcessContext => ({
  users: new Map([
    [0, 'root'],
    [1000, 'anna'],
  ]),
  bootTime: 1_760_000_000,
  memoryTotalBytes: 8 * 1024 ** 3,
  cpuTotalTicks: 800,
  previousTicks: new Map([[processKey(raw()), 600]]),
  containers: new Map([[ID, { name: 'immich-server', catalogId: 'immich' }]]),
  rules: { appUid: APP, minUid: 1000 },
  ...change,
});

describe('toProcess', () => {
  it('works out CPU and memory as shares of the whole machine', () => {
    const p = toProcess(raw(), context());
    expect(p.cpuPercent).toBe(50); // 400 of 800 ticks
    expect(p.memoryPercent).toBe(6.25);
    expect(p).toMatchObject({
      user: 'anna',
      state: 'running',
      kernel: false,
      system: false,
      endable: true,
    });
  });

  it('shows 0 % CPU in the first reading and for a PID used again (another start time)', () => {
    expect(toProcess(raw(), context({ cpuTotalTicks: 0 })).cpuPercent).toBe(0);
    expect(toProcess(raw({ startTicks: '99999' }), context()).cpuPercent).toBe(0);
  });

  it('dates its start from the boot time (100 ticks a second)', () => {
    expect(toProcess(raw(), context()).startedAt).toBe(
      new Date((1_760_000_000 + 500) * 1000).toISOString(),
    );
    expect(toProcess(raw(), context({ bootTime: null })).startedAt).toBeNull();
  });

  it('names the container a process runs in, and the service', () => {
    const p = toProcess(raw({ containerId: ID, uids: [0, 0, 0, 0] }), context());
    expect(p.container).toEqual({ name: 'immich-server', catalogId: 'immich' });
    // Root inside a container: not a system process (shown at first), not endable here.
    expect(p).toMatchObject({ system: false, endable: false });
    expect(toProcess(raw({ containerId: '' }), context()).container).toEqual({
      name: null,
      catalogId: null,
    });
  });

  it('marks kernel threads and system accounts’ processes as system', () => {
    expect(toProcess(raw({ flags: 0x200000, uids: [0, 0, 0, 0] }), context())).toMatchObject({
      kernel: true,
      system: true,
    });
    expect(toProcess(raw({ uids: [109, 109, 109, 109] }), context())).toMatchObject({
      system: true,
      user: null,
    });
  });

  it('follows the configured people’s range for both “system” and “endable”', () => {
    const rules = { appUid: APP, minUid: 500 };
    expect(toProcess(raw({ uids: [600, 600, 600, 600] }), context({ rules }))).toMatchObject({
      system: false,
      endable: true,
    });
  });

  it('cuts a long command line', () => {
    expect(toProcess(raw({ command: 'x'.repeat(5000) }), context()).command).toHaveLength(1024);
  });
});

describe('isEndable: only a person’s process', () => {
  it.each([
    ['a person’s', raw(), true],
    ['root’s', raw({ uids: [0, 0, 0, 0] }), false],
    ['a system account’s', raw({ uids: [109, 109, 109, 109] }), false],
    ['nobody’s', raw({ uids: [65534, 65534, 65534, 65534] }), false],
    ['the app’s own', raw({ uids: [APP, APP, APP, APP] }), false],
    ['a person’s run with root’s rights (setuid)', raw({ uids: [1000, 0, 0, 0] }), false],
    ['a kernel thread', raw({ flags: 0x200000 }), false],
    ['in a container', raw({ containerId: ID }), false],
    ['in a container without its ID', raw({ containerId: '' }), false],
    ['PID 1', raw({ pid: 1 }), false],
  ])('%s: %s', (_, process, expected) => {
    expect(isEndable(process, { appUid: APP, minUid: 1000 })).toBe(expected);
  });
});
