import type { RawProcess } from '../host/host.model.js';
import { processKey } from '@ilex/shared';
import { toProcess } from './process-view.js';
import type { ProcessContext } from './processes.model.js';

const ID = 'b'.repeat(64);

const raw = (change: Partial<RawProcess> = {}): RawProcess => ({
  pid: 4312,
  name: 'python3',
  state: 'R',
  flags: 0x400000,
  cpuTicks: 1_000,
  priority: 20,
  nice: 0,
  startTicks: '50000',
  virtualBytes: 2 * 1024 ** 3,
  uids: [1000, 1000, 1000, 1000],
  rssBytes: 512 * 1024 * 1024,
  sharedBytes: 64 * 1024 * 1024,
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
  cores: 4,
  cpuTotalTicks: 800,
  previousTicks: new Map([[processKey(raw()), 600]]),
  containers: new Map([[ID, { name: 'immich-server', app: 'immich' }]]),
  ...change,
});

describe('toProcess', () => {
  it('works out CPU per core, like htop, and memory as a share of the machine', () => {
    const p = toProcess(raw(), context());
    expect(p.cpuPercent).toBe(200); // 400 of 800 ticks on 4 cores: two cores' worth
    expect(p.memoryPercent).toBe(6.25);
    expect(p).toMatchObject({
      user: 'anna',
      state: 'running',
      kernel: false,
      system: false,
      cpuSeconds: 10,
      priority: 20,
      nice: 0,
      virtualBytes: 2 * 1024 ** 3,
      sharedBytes: 64 * 1024 * 1024,
    });
  });

  it('never shows more than every core busy', () => {
    const previousTicks = new Map([[processKey(raw()), 0]]);
    expect(toProcess(raw(), context({ previousTicks, cpuTotalTicks: 100 })).cpuPercent).toBe(400);
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
    expect(p.container).toEqual({ name: 'immich-server', app: 'immich' });
    // Root inside a container: not a system process (shown at first).
    expect(p).toMatchObject({ system: false });
    expect(toProcess(raw({ containerId: '' }), context()).container).toEqual({
      name: null,
      app: null,
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

  it('cuts a long command line', () => {
    expect(toProcess(raw({ command: 'x'.repeat(5000) }), context()).command).toHaveLength(1024);
  });
});
