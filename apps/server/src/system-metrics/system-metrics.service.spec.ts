import { Logger } from '@nestjs/common';
import { type DiskUsage, HISTORY_WINDOW_MS, type HostInfo, type SystemUpdate } from '@ilex/shared';
import { RealtimeSubscriptions } from '../realtime/realtime-subscriptions.js';
import {
  DISK_INTERVAL_MS,
  FIRST_SAMPLE_DELAY_MS,
  SAMPLE_INTERVAL_MS,
} from './system-metrics.constants.js';
import { SystemMetricsService } from './system-metrics.service.js';
import type { SystemReader } from '../host/system-reader.js';
import type { CpuTimes, MemoryInfo, NetCounters } from '../host/host.model.js';
import type { Subscription } from 'rxjs';

const GiB = 1024 ** 3;
const host: HostInfo = {
  hostname: 'ilex',
  os: 'Debian GNU/Linux 13',
  kernel: '6.12.0',
  arch: 'arm64',
  cpuModel: null,
  cpuCores: 4,
};
const rootDisk: DiskUsage = {
  device: '/dev/sda1',
  mount: '/',
  fsType: 'ext4',
  sizeBytes: 100 * GiB,
  usedBytes: 40 * GiB,
};

/** Counters advance by a fixed amount per reading: 25% CPU, 1000 B/s in, 500 B/s out at 2 s. */
class FakeReader {
  readings = 0;
  diskReads = 0;
  cpu: CpuTimes = { idle: 0, total: 0 };
  net = new Map<string, NetCounters>([['eth0', { rxBytes: 0, txBytes: 0 }]]);
  memoryInfo: MemoryInfo = {
    totalBytes: 8 * GiB,
    availableBytes: 6 * GiB,
    swapTotalBytes: 2 * GiB,
    swapFreeBytes: 1.5 * GiB,
  };
  failCpu = false;
  /** Set to make a second interface appear; advances 4000 B per reading (2000 B/s at 2 s). */
  wlan0: NetCounters | null = null;

  async cpuTimes(): Promise<CpuTimes> {
    if (this.failCpu) throw new Error('cannot read /proc/stat');
    this.readings++;
    this.cpu = { idle: this.cpu.idle + 75, total: this.cpu.total + 100 };
    return this.cpu;
  }
  async netCounters(): Promise<Map<string, NetCounters>> {
    const eth0 = this.net.get('eth0')!;
    this.net = new Map([['eth0', { rxBytes: eth0.rxBytes + 2000, txBytes: eth0.txBytes + 1000 }]]);
    if (this.wlan0) {
      this.wlan0 = { rxBytes: this.wlan0.rxBytes + 4000, txBytes: this.wlan0.txBytes };
      this.net.set('wlan0', this.wlan0);
    }
    return this.net;
  }
  async memory(): Promise<MemoryInfo> {
    return this.memoryInfo;
  }
  reading: { celsius: number; criticalCelsius: number | null } | null = {
    celsius: 48,
    criticalCelsius: 100,
  };
  sensorLookups = 0;
  async cpuSensor() {
    this.sensorLookups++;
    return this.reading
      ? { chip: 'coretemp', label: null, input: 'x', celsius: 0, criticalCelsius: 100 }
      : null;
  }
  async temperature() {
    return this.reading;
  }
  async disks(): Promise<DiskUsage[]> {
    this.diskReads++;
    return [rootDisk];
  }
  loadAverage(): [number, number, number] {
    return [0.5, 0.4, 0.3];
  }
  uptimeSeconds(): number {
    return 3600;
  }
  async hostInfo(): Promise<HostInfo> {
    return host;
  }
}

describe('SystemMetricsService', () => {
  let reader: FakeReader;
  let service: SystemMetricsService;
  let published: SystemUpdate[];
  let subscription: Subscription | undefined;
  const start = () =>
    (subscription = service.updates$.subscribe((update) => published.push(update)));
  const stop = () => subscription?.unsubscribe();

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-10-11T12:00:00Z') });
    reader = new FakeReader();
    service = new SystemMetricsService(
      reader as unknown as SystemReader,
      new RealtimeSubscriptions(),
    );
    published = [];
  });

  afterEach(() => {
    stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reads nothing until started', async () => {
    await vi.advanceTimersByTimeAsync(10 * SAMPLE_INTERVAL_MS);
    expect(reader.readings).toBe(0);
    expect(service.collecting).toBe(false);
  });

  it('takes a baseline at once, the first sample after 1 s, then one every 2 s', async () => {
    start();
    await vi.advanceTimersByTimeAsync(0);
    expect(reader.readings).toBe(1);
    expect(published).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(FIRST_SAMPLE_DELAY_MS);
    expect(published).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(3 * SAMPLE_INTERVAL_MS);
    expect(published).toHaveLength(4);
  });

  it('computes CPU %, memory, swap and network rates', async () => {
    start();
    await vi.advanceTimersByTimeAsync(FIRST_SAMPLE_DELAY_MS + SAMPLE_INTERVAL_MS);
    const { sample, uptimeSeconds, disks } = published.at(-1)!;
    expect(sample.cpu).toEqual({ usagePercent: 25, loadAverage: [0.5, 0.4, 0.3] });
    expect(sample.memory).toEqual({
      totalBytes: 8 * GiB,
      usedBytes: 2 * GiB,
      availableBytes: 6 * GiB,
      swapTotalBytes: 2 * GiB,
      swapUsedBytes: 0.5 * GiB,
    });
    expect(sample.network).toEqual([{ name: 'eth0', rxBytesPerSec: 1000, txBytesPerSec: 500 }]);
    expect(sample.at).toBe(Date.now());
    expect(uptimeSeconds).toBe(3600);
    expect(disks).toEqual([rootDisk]);
    expect(sample.temperature).toEqual({ celsius: 48, criticalCelsius: 100 });
  });

  it('finds the temperature sensor once per run, then only reads it', async () => {
    start();
    await vi.advanceTimersByTimeAsync(FIRST_SAMPLE_DELAY_MS + 3 * SAMPLE_INTERVAL_MS);
    expect(reader.sensorLookups).toBe(1);
  });

  it('carries no temperature without a sensor, in the sample and the history', async () => {
    reader.reading = null;
    start();
    await vi.advanceTimersByTimeAsync(FIRST_SAMPLE_DELAY_MS);
    expect(published.at(-1)!.sample.temperature).toBeNull();
    expect((await service.snapshot()).history.at(-1)!.temperatureC).toBeNull();
  });

  it('reports a new interface at 0 until its second reading', async () => {
    start();
    await vi.advanceTimersByTimeAsync(FIRST_SAMPLE_DELAY_MS);
    reader.wlan0 = { rxBytes: 5000, txBytes: 5000 };
    await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS);
    expect(published.at(-1)!.sample.network[1]).toEqual({
      name: 'wlan0',
      rxBytesPerSec: 0,
      txBytesPerSec: 0,
    });
    await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS);
    expect(published.at(-1)!.sample.network[1].rxBytesPerSec).toBe(2000);
  });

  it('reads disks at start and then every 30 s', async () => {
    start();
    await vi.advanceTimersByTimeAsync(FIRST_SAMPLE_DELAY_MS);
    expect(reader.diskReads).toBe(1);
    await vi.advanceTimersByTimeAsync(DISK_INTERVAL_MS - SAMPLE_INTERVAL_MS);
    expect(reader.diskReads).toBe(1);
    await vi.advanceTimersByTimeAsync(2 * SAMPLE_INTERVAL_MS);
    expect(reader.diskReads).toBe(2);
  });

  it('stops reading when unsubscribed, leaving no timers', async () => {
    start();
    await vi.advanceTimersByTimeAsync(FIRST_SAMPLE_DELAY_MS);
    stop();
    const readings = reader.readings;
    await vi.advanceTimersByTimeAsync(10 * SAMPLE_INTERVAL_MS);
    expect(reader.readings).toBe(readings);
    expect(service.collecting).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drops a reading that finishes after stop', async () => {
    start();
    await vi.advanceTimersByTimeAsync(FIRST_SAMPLE_DELAY_MS - 1);
    let release!: () => void;
    const cpuTimes = reader.cpuTimes.bind(reader);
    vi.spyOn(reader, 'cpuTimes').mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return cpuTimes();
    });
    await vi.advanceTimersByTimeAsync(1);
    stop();
    release();
    await vi.advanceTimersByTimeAsync(10 * SAMPLE_INTERVAL_MS);
    expect(published).toHaveLength(0);
  });

  describe('snapshot', () => {
    it('waits for the first sample, then includes host info and history', async () => {
      start();
      const snapshot = service.snapshot();
      await vi.advanceTimersByTimeAsync(FIRST_SAMPLE_DELAY_MS);
      const { host: snapshotHost, history, sample } = await snapshot;
      expect(snapshotHost).toEqual(host);
      expect(sample).toEqual(published[0].sample);
      expect(history).toEqual([
        {
          at: sample.at,
          cpuPercent: 25,
          memoryUsedBytes: 2 * GiB,
          // The first sample spans 1 s.
          rxBytesPerSec: 2000,
          txBytesPerSec: 1000,
          temperatureC: 48,
        },
      ]);
    });

    it('answers at once while collecting', async () => {
      start();
      await vi.advanceTimersByTimeAsync(FIRST_SAMPLE_DELAY_MS + 2 * SAMPLE_INTERVAL_MS);
      const { history, sample } = await service.snapshot();
      expect(history).toHaveLength(3);
      expect(sample).toEqual(published.at(-1)!.sample);
    });

    it('fails when stopped before the first sample, and when not collecting', async () => {
      start();
      const snapshot = service.snapshot();
      stop();
      await expect(snapshot).rejects.toThrow(/stopped/);
      await expect(service.snapshot()).rejects.toThrow(/not being collected/);
    });

    it('keeps history across a pause, until it is 15 minutes old', async () => {
      start();
      await vi.advanceTimersByTimeAsync(FIRST_SAMPLE_DELAY_MS + SAMPLE_INTERVAL_MS);
      stop();
      await vi.advanceTimersByTimeAsync(5 * 60_000);

      start();
      await vi.advanceTimersByTimeAsync(FIRST_SAMPLE_DELAY_MS);
      expect((await service.snapshot()).history).toHaveLength(3);

      stop();
      await vi.advanceTimersByTimeAsync(HISTORY_WINDOW_MS);
      start();
      await vi.advanceTimersByTimeAsync(FIRST_SAMPLE_DELAY_MS);
      expect((await service.snapshot()).history).toHaveLength(1);
    });

    it('holds at most 15 minutes of points', async () => {
      start();
      await vi.advanceTimersByTimeAsync(FIRST_SAMPLE_DELAY_MS + 2 * HISTORY_WINDOW_MS);
      const { history } = await service.snapshot();
      expect(history).toHaveLength(HISTORY_WINDOW_MS / SAMPLE_INTERVAL_MS);
      expect(history[0].at).toBeGreaterThanOrEqual(Date.now() - HISTORY_WINDOW_MS);
    });
  });

  it('logs a failed reading and keeps trying', async () => {
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    reader.failCpu = true;
    start();
    await vi.advanceTimersByTimeAsync(3 * FIRST_SAMPLE_DELAY_MS);
    expect(logged).toHaveBeenCalled();
    reader.failCpu = false;
    await vi.advanceTimersByTimeAsync(2 * FIRST_SAMPLE_DELAY_MS);
    expect(published.length).toBeGreaterThan(0);
  });

  it('skips a sample that fails to compute, and goes on', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    start();
    await vi.advanceTimersByTimeAsync(FIRST_SAMPLE_DELAY_MS);
    expect(published).toHaveLength(1);
    vi.spyOn(reader, 'memory').mockResolvedValueOnce(null as unknown as MemoryInfo);
    await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS);
    expect(published).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS);
    expect(published).toHaveLength(2);
    expect(service.collecting).toBe(true);
  });

  it('registers itself as the system topic source', () => {
    const subscriptions = new RealtimeSubscriptions();
    const register = vi.spyOn(subscriptions, 'registerSource');
    const registered = new SystemMetricsService(reader as unknown as SystemReader, subscriptions);
    expect(register).toHaveBeenCalledWith(registered);
  });
});
