import { Injectable, Logger } from '@nestjs/common';
import {
  type DiskUsage,
  type HostInfo,
  type SystemHistoryPoint,
  type SystemSnapshot,
  type SystemUpdate,
  toSystemHistoryPoint,
} from '@laris/shared';
import {
  defer,
  filter,
  finalize,
  firstValueFrom,
  type Observable,
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
import type { CpuTimes, NetCounters } from '../host/host.model.js';

export const SAMPLE_INTERVAL_MS = 2_000;
/** The first sample needs two readings; this keeps a new dashboard's wait short. */
export const FIRST_SAMPLE_DELAY_MS = 1_000;
export const DISK_INTERVAL_MS = 30_000;
export const HISTORY_WINDOW_MS = 15 * 60_000;

/** The previous reading, which rates and CPU % are computed against. */
interface Reading {
  at: number;
  cpu: CpuTimes;
  net: Map<string, NetCounters>;
}

/** State of one collecting period: while `updates$` is subscribed. */
interface Run {
  previous: Reading | null;
  disks: DiskUsage[];
  disksAt: number;
  latest: SystemUpdate | null;
  /** The first sample, for snapshots taken before it; fails when collecting stops first. */
  first$: ReplaySubject<SystemUpdate>;
}

/**
 * The `system` topic: samples CPU, memory and network every 2 s and disks every 30 s — only
 * while someone is subscribed (the registry subscribes to `updates$`). Keeps the last 15 minutes
 * of chart points; points from before a pause stay until they age out.
 */
@Injectable()
export class SystemMetricsService implements TopicSource<'system'> {
  readonly topic = 'system';
  private readonly logger = new Logger(SystemMetricsService.name);
  private readonly history = new RingBuffer<SystemHistoryPoint>(
    HISTORY_WINDOW_MS / SAMPLE_INTERVAL_MS,
  );
  private hostInfo: Promise<HostInfo> | null = null;
  private run: Run | null = null;

  /**
   * While subscribed: a baseline reading at once, the first sample 1 s later, then a sample 2 s
   * after each reading ends (never two at a time).
   */
  readonly updates$: Observable<SystemUpdate> = defer(() => {
    const run = this.begin();
    return defer(() => this.read(run)).pipe(
      repeat({ delay: () => timer(run.latest ? SAMPLE_INTERVAL_MS : FIRST_SAMPLE_DELAY_MS) }),
      filter((update): update is SystemUpdate => update !== null),
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

  /** Waits for the first sample when collecting has only just started. */
  async snapshot(): Promise<SystemSnapshot> {
    const run = this.run;
    if (!run) throw new Error('System metrics are not being collected');
    const latest = run.latest ?? (await firstValueFrom(run.first$));
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
    const run: Run = {
      previous: null,
      disks: [],
      disksAt: -Infinity,
      latest: null,
      first$: new ReplaySubject(1),
    };
    this.run = run;
    return run;
  }

  private end(run: Run): void {
    if (this.run === run) this.run = null;
    run.first$.error(new Error('System metrics stopped'));
  }

  /** One reading: the update, or null for the baseline, a failed reading or one after the end. */
  private async read(run: Run): Promise<SystemUpdate | null> {
    try {
      const at = Date.now();
      const [cpu, net, memory] = await Promise.all([
        this.reader.cpuTimes(),
        this.reader.netCounters(),
        this.reader.memory(),
      ]);
      if (at - run.disksAt >= DISK_INTERVAL_MS) await this.refreshDisks(run, at);
      if (run !== this.run) return null;

      const previous = run.previous;
      run.previous = { at, cpu, net };
      if (!previous) return null;

      const seconds = (at - previous.at) / 1000;
      const update: SystemUpdate = {
        uptimeSeconds: this.reader.uptimeSeconds(),
        sample: {
          at,
          cpu: {
            usagePercent: cpuUsagePercent(previous.cpu, cpu),
            loadAverage: this.reader.loadAverage(),
          },
          memory: {
            totalBytes: memory.totalBytes,
            usedBytes: Math.max(0, memory.totalBytes - memory.availableBytes),
            availableBytes: memory.availableBytes,
            swapTotalBytes: memory.swapTotalBytes,
            swapUsedBytes: Math.max(0, memory.swapTotalBytes - memory.swapFreeBytes),
          },
          network: [...net].map(([name, counters]) => {
            const before = previous.net.get(name) ?? counters; // new interface: 0 until next time
            return {
              name,
              rxBytesPerSec: bytesPerSecond(before.rxBytes, counters.rxBytes, seconds),
              txBytesPerSec: bytesPerSecond(before.txBytes, counters.txBytes, seconds),
            };
          }),
        },
        disks: run.disks,
      };
      run.latest = update;
      this.history.push(toSystemHistoryPoint(update.sample));
      run.first$.next(update);
      return update;
    } catch (error) {
      this.logger.error('Reading system metrics failed', (error as Error).stack);
      return null;
    }
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
