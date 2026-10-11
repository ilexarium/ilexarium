import { diskUsageSchema, hostInfoSchema } from '@homelab/shared';
import { SystemReader } from './system-reader.js';

// Against the machine running the tests (the app only runs on Linux): proves the real files
// parse, without asserting values that differ between machines.
describe('SystemReader (this machine)', () => {
  const reader = new SystemReader();

  it('reads CPU times and memory', async () => {
    const cpu = await reader.cpuTimes();
    expect(cpu.total).toBeGreaterThan(cpu.idle);
    const memory = await reader.memory();
    expect(memory.totalBytes).toBeGreaterThan(0);
    expect(memory.availableBytes).toBeLessThanOrEqual(memory.totalBytes);
  });

  it('reads network counters without loopback', async () => {
    const counters = await reader.netCounters();
    expect(counters.has('lo')).toBe(false);
  });

  it('reads at least the root filesystem, in the shared shape', async () => {
    const disks = await reader.disks();
    expect(disks.map((disk) => disk.mount)).toContain('/');
    for (const disk of disks) expect(diskUsageSchema.parse(disk)).toEqual(disk);
  });

  it('reads host info in the shared shape', async () => {
    const host = await reader.hostInfo();
    expect(hostInfoSchema.parse(host)).toEqual(host);
  });

  it('fails clearly when the files are not there', async () => {
    await expect(new SystemReader('/nonexistent').cpuTimes()).rejects.toThrow(/ENOENT/);
  });
});
