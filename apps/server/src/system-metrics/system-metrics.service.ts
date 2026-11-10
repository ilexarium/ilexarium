import { Injectable, Logger } from '@nestjs/common';
import {
  type DiskUsage,
  HISTORY_WINDOW_MS,
  type HostInfo,
  type SystemHistoryPoint,
  type SystemSnapshot,
  type SystemUpdate,
  toSystemHistoryPoint,
} from '@ilex/shared';
import {
  catchError,
  concatMap,
  defer,
  EMPTY,
  finalize,
  firstValueFrom,
  type Observable,
  pairwise,
  ReplaySubject,
  repeat,
  share,
  timer,
} from 'rxjs';
import { RingBuffer } from '../common/ring-buffer.js';
import { RealtimeSubscriptions } from '../realtime/realtime-subscriptions.js';
import { bytesPerSecond, cpuUsagePercent } from '../host/proc-parsers.js';
import { SystemReader } from '../host/system-reader.js';
import type { TopicSource } from '../realtime/realtime.model.js';
import type { CpuTimes, MemoryInfo, NetCounters, TemperatureSensor } from '../host/host.model.js';
import type { CpuTemperature } from '../host/thermal-parsers.js';
import {
  DISK_INTERVAL_MS,
  FIRST_SAMPLE_DELAY_MS,
  SAMPLE_INTERVAL_MS,
} from './system-metrics.constants.js';

interface Reading {
  at: number;
  cpu: CpuTimes;
  net: Map<string, NetCounters>;
  memory: MemoryInfo;
  disks: DiskUsage[];
  loadAverage: [number, number, number];
  uptimeSeconds: number;
  temperature: CpuTemperature | null;
}

/** One collecting period: while `updates$` is subscribed. */
interface Run {
  disks: DiskUsage[];
  disksAt: number;
  sampled: boolean;
  /** Where the processor's temperature is read: found once per run (null without a sensor). */
  sensor: Promise<TemperatureSensor | null> | null;
  /** The latest update; a snapshot taken before the first waits for it (and fails if it stops). */
  latest$: ReplaySubject<SystemUpdate>;
}

/** CPU % and network rates are the change between two readings. */
function toUpdate(previous: Reading, current: Reading): SystemUpdate {
  const seconds = (current.at - previous.at) / 1000;
  const { memory } = current;
  return {
    uptimeSeconds: current.uptimeSeconds,
    sample: {
      at: current.at,
      cpu: {
        usagePercent: cpuUsagePercent(previous.cpu, current.cpu),
        loadAverage: current.loadAverage,
      },
      memory: {
        totalBytes: memory.totalBytes,
        usedBytes: Math.max(0, memory.totalBytes - memory.availableBytes),
        availableBytes: memory.availableBytes,
        swapTotalBytes: memory.swapTotalBytes,
        swapUsedBytes: Math.max(0, memory.swapTotalBytes - memory.swapFreeBytes),
      },
      network: [...current.net].map(([name, counters]) => {
        const before = previous.net.get(name) ?? counters; // new interface: 0 until next time
        return {
          name,
          rxBytesPerSec: bytesPerSecond(before.rxBytes, counters.rxBytes, seconds),
          txBytesPerSec: bytesPerSecond(before.txBytes, counters.txBytes, seconds),
        };
      }),
      temperature: current.temperature,
    },
    disks: current.disks,
  };
}

/** Points from before a pause stay until they are 15 minutes old. */
@Injectable()
export class SystemMetricsService implements TopicSource<'system'> {
  readonly topic = 'system';
  private readonly logger = new Logger(SystemMetricsService.name);
  private readonly history = new RingBuffer<SystemHistoryPoint>(
    HISTORY_WINDOW_MS / SAMPLE_INTERVAL_MS,
  );
  private hostInfo: Promise<HostInfo> | null = null;
  private run: Run | null = null;

  /** A reading at once, the next 1 s later, then one 2 s after each ends: never two at a time. */
  readonly updates$: Observable<SystemUpdate> = defer(() => {
    const run = this.begin();
    return defer(() => this.read(run)).pipe(
      catchError((error: Error) => {
        this.logger.error('Reading system metrics failed', error.stack);
        return EMPTY;
      }),
      repeat({ delay: () => timer(run.sampled ? SAMPLE_INTERVAL_MS : FIRST_SAMPLE_DELAY_MS) }),
      pairwise(),
      concatMap(([previous, current]) => this.sample(run, previous, current)),
      finalize(() => this.end(run)),
    );
  }).pipe(share());

  constructor(
    private readonly reader: SystemReader,
    subscriptions: RealtimeSubscriptions,
  ) {
    subscriptions.registerSource(this);
  }

  get collecting(): boolean {
    return this.run !== null;
  }

  async snapshot(): Promise<SystemSnapshot> {
    if (!this.run) throw new Error('System metrics are not being collected');
    const latest = await firstValueFrom(this.run.latest$);
    const cutoff = Date.now() - HISTORY_WINDOW_MS;
    return {
      ...latest,
      host: await this.host(),
      history: this.history.toArray().filter((point) => point.at >= cutoff),
    };
  }

  /** Read once: it doesn't change while running (a failed read is tried again next time). */
  host(): Promise<HostInfo> {
    this.hostInfo ??= this.reader.hostInfo().catch((error: unknown) => {
      this.hostInfo = null;
      throw error;
    });
    return this.hostInfo;
  }

  private begin(): Run {
    this.run = {
      disks: [],
      disksAt: -Infinity,
      sampled: false,
      sensor: null,
      latest$: new ReplaySubject(1),
    };
    return this.run;
  }

  private end(run: Run): void {
    if (this.run === run) this.run = null;
    run.latest$.error(new Error('System metrics stopped'));
  }

  /** A failure here skips this sample only: an error must never reach the subscription. */
  private sample(run: Run, previous: Reading, current: Reading): SystemUpdate[] {
    try {
      const update = toUpdate(previous, current);
      run.sampled = true;
      this.history.push(toSystemHistoryPoint(update.sample));
      run.latest$.next(update);
      return [update];
    } catch (error) {
      this.logger.error('Computing system metrics failed', (error as Error).stack);
      return [];
    }
  }

  private async read(run: Run): Promise<Reading> {
    const at = Date.now();
    const [cpu, net, memory, temperature] = await Promise.all([
      this.reader.cpuTimes(),
      this.reader.netCounters(),
      this.reader.memory(),
      this.temperature(run),
    ]);
    if (at - run.disksAt >= DISK_INTERVAL_MS) await this.refreshDisks(run, at);
    return {
      at,
      cpu,
      net,
      memory,
      disks: run.disks,
      loadAverage: this.reader.loadAverage(),
      uptimeSeconds: this.reader.uptimeSeconds(),
      temperature,
    };
  }

  private async temperature(run: Run): Promise<CpuTemperature | null> {
    run.sensor ??= this.reader.cpuSensor().catch((error: unknown) => {
      this.logger.error('Finding the temperature sensor failed', (error as Error).stack);
      return null;
    });
    const sensor = await run.sensor;
    return sensor ? this.reader.temperature(sensor) : null;
  }

  /** On failure the previous list stays, and it is tried again next time. */
  private async refreshDisks(run: Run, at: number): Promise<void> {
    try {
      run.disks = await this.reader.disks();
      run.disksAt = at;
    } catch (error) {
      this.logger.error('Reading disk usage failed', (error as Error).stack);
    }
  }
}
