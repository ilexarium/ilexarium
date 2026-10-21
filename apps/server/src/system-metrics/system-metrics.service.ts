import { Injectable, Logger } from '@nestjs/common';
import {
  type DiskUsage,
  HISTORY_WINDOW_MS,
  type HostInfo,
  type SystemHistoryPoint,
  type SystemSnapshot,
  type SystemUpdate,
  toSystemHistoryPoint,
} from '@laris/shared';
import {
  catchError,
  defer,
  EMPTY,
  finalize,
  firstValueFrom,
  map,
  type Observable,
  pairwise,
  ReplaySubject,
  repeat,
  share,
  tap,
  timer,
} from 'rxjs';
import { RingBuffer } from '../common/ring-buffer.js';
import { RealtimeSubscriptions } from '../realtime/realtime-subscriptions.js';
import { bytesPerSecond, cpuUsagePercent } from '../host/proc-parsers.js';
import { SystemReader } from '../host/system-reader.js';
import type { TopicSource } from '../realtime/realtime.model.js';
import type { CpuTimes, MemoryInfo, NetCounters } from '../host/host.model.js';
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
}

/** One collecting period: while `updates$` is subscribed. */
interface Run {
  disks: DiskUsage[];
  disksAt: number;
  sampled: boolean;
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
      map(([previous, current]) => toUpdate(previous, current)),
      tap((update) => {
        run.sampled = true;
        this.history.push(toSystemHistoryPoint(update.sample));
        run.latest$.next(update);
      }),
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

  private host(): Promise<HostInfo> {
    this.hostInfo ??= this.reader.hostInfo();
    return this.hostInfo;
  }

  private begin(): Run {
    this.run = { disks: [], disksAt: -Infinity, sampled: false, latest$: new ReplaySubject(1) };
    return this.run;
  }

  private end(run: Run): void {
    if (this.run === run) this.run = null;
    run.latest$.error(new Error('System metrics stopped'));
  }

  private async read(run: Run): Promise<Reading> {
    const at = Date.now();
    const [cpu, net, memory] = await Promise.all([
      this.reader.cpuTimes(),
      this.reader.netCounters(),
      this.reader.memory(),
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
    };
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
