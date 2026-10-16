import { Injectable, Logger } from '@nestjs/common';
import {
  type Container,
  type ContainerHistoryPoint,
  type ContainersSnapshot,
  type ContainersUpdate,
  type ContainerStats,
  toContainerHistoryPoint,
} from '@homelab/shared';
import { Observable } from 'rxjs';
import { RingBuffer } from '../common/ring-buffer.js';
import { DockerService } from '../docker/docker.service.js';
import { RealtimeSubscriptions } from '../realtime/realtime-subscriptions.js';
import type { DockerContainer } from '../docker/docker.model.js';
import type { TopicSource } from '../realtime/realtime.model.js';

export const PUBLISH_INTERVAL_MS = 2_000;
/** Fallback when an event is missed (or the events stream is down). */
export const REFRESH_INTERVAL_MS = 10_000;
/** Events come in bursts (stop → die → stop); one refresh for the burst. */
export const EVENT_DEBOUNCE_MS = 250;
export const HISTORY_WINDOW_MS = 15 * 60_000;
const HISTORY_CAPACITY = HISTORY_WINDOW_MS / PUBLISH_INTERVAL_MS;

/** State of one collecting period, from `start()` to `stop()`. */
interface Run {
  publish: (update: ContainersUpdate) => void;
  /** `null` until the first refresh has answered. */
  dockerAvailable: boolean | null;
  containers: DockerContainer[];
  stats: Map<string, ContainerStats>;
  /** One open stats stream per running container. */
  statsStreams: Map<string, AbortController>;
  events: AbortController | null;
  refreshing: Promise<void> | null;
  refreshAgain: boolean;
  timers: NodeJS.Timeout[];
  debounce: NodeJS.Timeout | null;
  /** Snapshots waiting for the first refresh. */
  waiters: { resolve: () => void; reject: (error: Error) => void }[];
}

/**
 * The `containers` topic. While someone is subscribed: the container list (refreshed on Docker
 * events, and every 10 s as a fallback), one stats stream per running container, and an update
 * every 2 s. Unsubscribed, every stream is closed. Docker unreachable → `dockerAvailable: false`,
 * retried at each refresh. Chart history: 15 minutes per container, dropped when it is removed.
 */
@Injectable()
export class ContainersService implements TopicSource<'containers'> {
  readonly topic = 'containers';
  private readonly logger = new Logger(ContainersService.name);
  private readonly history = new Map<string, RingBuffer<ContainerHistoryPoint>>();
  private run: Run | null = null;

  /** While subscribed: collecting (moved onto RxJS in its own step). */
  readonly updates$ = new Observable<ContainersUpdate>((subscriber) => {
    this.start((update) => subscriber.next(update));
    return () => this.stop();
  });

  constructor(
    private readonly docker: DockerService,
    subscriptions: RealtimeSubscriptions,
  ) {
    subscriptions.registerSource(this);
  }

  get collecting(): boolean {
    return this.run !== null;
  }

  /** Open Docker streams (stats and events) — for tests: must be 0 when not collecting. */
  get openStreams(): number {
    if (!this.run) return 0;
    return this.run.statsStreams.size + (this.run.events ? 1 : 0);
  }

  start(publish: (update: ContainersUpdate) => void): void {
    const run: Run = {
      publish,
      dockerAvailable: null,
      containers: [],
      stats: new Map(),
      statsStreams: new Map(),
      events: null,
      refreshing: null,
      refreshAgain: false,
      timers: [],
      debounce: null,
      waiters: [],
    };
    this.run = run;
    run.timers.push(
      setInterval(() => void this.refresh(run), REFRESH_INTERVAL_MS),
      setInterval(() => this.publishUpdate(run), PUBLISH_INTERVAL_MS),
    );
    void this.refresh(run);
  }

  stop(): void {
    const run = this.run;
    if (!run) return;
    this.run = null;
    for (const timer of run.timers) clearInterval(timer);
    if (run.debounce) clearTimeout(run.debounce);
    this.closeStreams(run);
    for (const { reject } of run.waiters) reject(new Error('Container monitoring stopped'));
  }

  /** Waits for the first refresh when collecting has only just started. */
  async snapshot(): Promise<ContainersSnapshot> {
    const run = this.run;
    if (!run) throw new Error('Containers are not being monitored');
    if (run.dockerAvailable === null) {
      await new Promise<void>((resolve, reject) => run.waiters.push({ resolve, reject }));
    }
    if (!run.dockerAvailable) return { dockerAvailable: false };
    const cutoff = Date.now() - HISTORY_WINDOW_MS;
    const history: Record<string, ContainerHistoryPoint[]> = {};
    for (const { id } of run.containers) {
      const points = this.history
        .get(id)
        ?.toArray()
        .filter((point) => point.at >= cutoff);
      if (points?.length) history[id] = points;
    }
    return { dockerAvailable: true, containers: this.withStats(run), history };
  }

  /** One refresh at a time; a request during one runs once more after it. */
  private refresh(run: Run): Promise<void> {
    if (run.refreshing) {
      run.refreshAgain = true;
      return run.refreshing;
    }
    run.refreshing = (async () => {
      do {
        run.refreshAgain = false;
        await this.refreshOnce(run);
      } while (run.refreshAgain && run === this.run);
      run.refreshing = null;
    })();
    return run.refreshing;
  }

  private async refreshOnce(run: Run): Promise<void> {
    let containers: DockerContainer[] | null = null;
    try {
      containers = await this.docker.listContainers();
    } catch (error) {
      if (run.dockerAvailable !== false && run === this.run) {
        this.logger.warn(`Docker is not reachable: ${(error as Error).message}`);
      }
    }
    if (run !== this.run) return;

    if (!containers) {
      run.dockerAvailable = false;
      run.containers = [];
      run.stats.clear();
      this.closeStreams(run);
    } else {
      run.dockerAvailable = true;
      run.containers = containers;
      this.syncStatsStreams(run);
      if (!run.events) this.openEvents(run);
      this.dropRemovedHistory(containers);
    }
    for (const { resolve } of run.waiters.splice(0)) resolve();
  }

  /** A stats stream for every running container, and none for anything else. */
  private syncStatsStreams(run: Run): void {
    const running = new Set(run.containers.filter((c) => c.state === 'running').map((c) => c.id));
    for (const [id, controller] of run.statsStreams) {
      if (running.has(id)) continue;
      controller.abort();
      run.statsStreams.delete(id);
      run.stats.delete(id);
    }
    for (const id of running) {
      if (!run.statsStreams.has(id)) this.openStats(run, id);
    }
  }

  private openStats(run: Run, id: string): void {
    const controller = new AbortController();
    run.statsStreams.set(id, controller);
    void (async () => {
      try {
        for await (const stats of this.docker.containerStats(id, controller.signal)) {
          if (controller.signal.aborted) break;
          run.stats.set(id, stats);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          this.logger.debug(`Stats stream for ${id} ended: ${(error as Error).message}`);
        }
      } finally {
        // Ended by itself (container stopped, Docker restarted): the next refresh decides.
        if (run.statsStreams.get(id) === controller) run.statsStreams.delete(id);
      }
    })();
  }

  private openEvents(run: Run): void {
    const controller = new AbortController();
    run.events = controller;
    void (async () => {
      try {
        for await (const _event of this.docker.containerEvents(controller.signal)) {
          if (controller.signal.aborted) break;
          this.scheduleRefresh(run);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          this.logger.debug(`Docker events stream ended: ${(error as Error).message}`);
        }
      } finally {
        if (run.events === controller) run.events = null; // reopened at the next refresh
      }
    })();
  }

  private scheduleRefresh(run: Run): void {
    if (run.debounce || run !== this.run) return;
    run.debounce = setTimeout(() => {
      run.debounce = null;
      void this.refresh(run);
    }, EVENT_DEBOUNCE_MS);
  }

  private closeStreams(run: Run): void {
    for (const controller of run.statsStreams.values()) controller.abort();
    run.statsStreams.clear();
    run.events?.abort();
    run.events = null;
  }

  private publishUpdate(run: Run): void {
    if (run.dockerAvailable === null) return;
    if (!run.dockerAvailable) {
      run.publish({ dockerAvailable: false });
      return;
    }
    const containers = this.withStats(run);
    for (const { id, stats } of containers) {
      if (stats) this.recordHistory(id, stats);
    }
    run.publish({ dockerAvailable: true, containers });
  }

  private withStats(run: Run): Container[] {
    return run.containers.map((container) => ({
      ...container,
      stats: container.state === 'running' ? (run.stats.get(container.id) ?? null) : null,
    }));
  }

  /** One point per new stats frame (a stalled stream adds nothing). */
  private recordHistory(id: string, stats: ContainerStats): void {
    let buffer = this.history.get(id);
    if (!buffer) {
      buffer = new RingBuffer(HISTORY_CAPACITY);
      this.history.set(id, buffer);
    }
    const last = buffer.last();
    if (!last || stats.at > last.at) buffer.push(toContainerHistoryPoint(stats));
  }

  private dropRemovedHistory(containers: DockerContainer[]): void {
    const present = new Set(containers.map((c) => c.id));
    for (const id of this.history.keys()) {
      if (!present.has(id)) this.history.delete(id);
    }
  }
}
