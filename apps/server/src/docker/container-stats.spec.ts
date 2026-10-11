import { cpuPercent, memoryUsedBytes, toContainerStats } from './container-stats.js';
import type { RawContainerStats } from './docker.model.js';

/** A real frame (Postgres in Docker 29, cgroup v2), trimmed to the fields we read. */
const frame: RawContainerStats = {
  read: '2026-10-11T16:03:29.374469361Z',
  cpu_stats: {
    cpu_usage: { total_usage: 55_666_747_000 },
    system_cpu_usage: 92_457_880_000_000,
    online_cpus: 8,
  },
  precpu_stats: {
    cpu_usage: { total_usage: 55_666_747_000 },
    system_cpu_usage: 92_449_690_000_000,
    online_cpus: 8,
  },
  memory_stats: {
    usage: 113_831_936,
    stats: { inactive_file: 41_111_552, active_file: 12_369_920, anon: 5_816_320 },
    limit: 12_510_502_912,
  },
  networks: { eth0: { rx_bytes: 2_908_718, tx_bytes: 2_334_883 } },
  blkio_stats: {
    io_service_bytes_recursive: [
      { op: 'read', value: 2_031_616 },
      { op: 'write', value: 160_272_384 },
    ],
  },
};

describe('cpuPercent', () => {
  it('uses the Docker CLI formula: delta / system delta × CPUs × 100', () => {
    const busy = {
      ...frame,
      cpu_stats: { ...frame.cpu_stats, cpu_usage: { total_usage: 55_666_747_000 + 409_500_000 } },
    };
    // 0.4095 s of 8.19 s system time (8 CPUs × ~1.02 s) → 5 % of the machine = 40 % of one core
    expect(cpuPercent(busy)).toBeCloseTo(40, 5);
  });

  it('is 0 for an idle container (as in the sample)', () => {
    expect(cpuPercent(frame)).toBe(0);
  });

  it('is 0 on the first frame, which has no previous reading', () => {
    expect(cpuPercent({ ...frame, precpu_stats: { cpu_usage: { total_usage: 0 } } })).toBe(0);
  });

  it('counts per-CPU entries on old daemons without online_cpus', () => {
    const old: RawContainerStats = {
      cpu_stats: {
        cpu_usage: { total_usage: 300, percpu_usage: [1, 1, 1, 1] },
        system_cpu_usage: 2000,
      },
      precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
    };
    expect(cpuPercent(old)).toBe(80);
  });

  it('can exceed 100 when using more than one core', () => {
    const busy: RawContainerStats = {
      cpu_stats: { cpu_usage: { total_usage: 1500 }, system_cpu_usage: 2000, online_cpus: 4 },
      precpu_stats: { cpu_usage: { total_usage: 1000 }, system_cpu_usage: 1000 },
    };
    expect(cpuPercent(busy)).toBe(200);
  });
});

describe('memoryUsedBytes', () => {
  it('leaves out inactive page cache on cgroup v2, like docker stats', () => {
    expect(memoryUsedBytes(frame)).toBe(113_831_936 - 41_111_552);
  });

  it('uses total_inactive_file on cgroup v1', () => {
    expect(
      memoryUsedBytes({ memory_stats: { usage: 1000, stats: { total_inactive_file: 300 } } }),
    ).toBe(700);
  });

  it('keeps the usage when the cache figure is missing or not below it', () => {
    expect(memoryUsedBytes({ memory_stats: { usage: 1000 } })).toBe(1000);
    expect(memoryUsedBytes({ memory_stats: { usage: 1000, stats: { inactive_file: 1000 } } })).toBe(
      1000,
    );
  });
});

describe('toContainerStats', () => {
  it('converts a full frame', () => {
    expect(toContainerStats(frame, 0)).toEqual({
      at: Date.parse('2026-10-11T16:03:29.374Z'),
      cpuPercent: 0,
      memoryUsedBytes: 72_720_384,
      memoryLimitBytes: 12_510_502_912,
      netRxBytes: 2_908_718,
      netTxBytes: 2_334_883,
      blockReadBytes: 2_031_616,
      blockWriteBytes: 160_272_384,
    });
  });

  it('sums every network and accepts capitalised block I/O operations (cgroup v1)', () => {
    const stats = toContainerStats(
      {
        networks: { eth0: { rx_bytes: 10, tx_bytes: 1 }, eth1: { rx_bytes: 5, tx_bytes: 2 } },
        blkio_stats: {
          io_service_bytes_recursive: [
            { op: 'Read', value: 7 },
            { op: 'Write', value: 3 },
            { op: 'Total', value: 10 },
          ],
        },
      },
      42,
    );
    expect(stats).toMatchObject({
      netRxBytes: 15,
      netTxBytes: 3,
      blockReadBytes: 7,
      blockWriteBytes: 3,
    });
  });

  it('copes with an almost empty frame, using the fallback time', () => {
    expect(
      toContainerStats(
        { read: '0001-01-01T00:00:00Z', blkio_stats: { io_service_bytes_recursive: null } },
        42,
      ),
    ).toEqual({
      at: 42,
      cpuPercent: 0,
      memoryUsedBytes: 0,
      memoryLimitBytes: 0,
      netRxBytes: 0,
      netTxBytes: 0,
      blockReadBytes: 0,
      blockWriteBytes: 0,
    });
  });
});
