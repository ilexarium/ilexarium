import { Injectable, Logger } from '@nestjs/common';
import {
  type Container,
  type ContainerHistoryPoint,
  type ContainersSnapshot,
  type ContainersUpdate,
  type ContainerStats,
  HISTORY_WINDOW_MS,
  toContainerHistoryPoint,
} from '@ilex/shared';
import {
  auditTime,
  defer,
  filter,
  finalize,
  firstValueFrom,
  ignoreElements,
  interval,
  map,
  merge,
  type Observable,
  of,
  ReplaySubject,
  share,
  Subject,
  type Subscription,
  tap,
} from 'rxjs';
import { fromAbortable } from '../common/from-abortable.js';
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
const HISTORY_CAPACITY = HISTORY_WINDOW_MS / PUBLISH_INTERVAL_MS;

/** State of one collecting period: while `updates$` is subscribed. */
interface Run {
  /** `null` until the first refresh has answered. */
  dockerAvailable: boolean | null;
  containers: DockerContainer[];
  stats: Map<string, ContainerStats>;
  /** One open stats stream per running container. */
  statsStreams: Map<string, Subscription>;
  events: Subscription | null;
  /** A notice for each Docker event (the events stream is reopened at refreshes). */
  eventNotices: Subject<void>;
  refreshing: Promise<void> | null;
  refreshAgain: boolean;
  /** The first refresh answered, for snapshots taken before it; fails when collecting stops first. */
  answered$: ReplaySubject<void>;
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

  /**
   * While subscribed: refreshes the list at once, every 10 s and after a burst of Docker events,
   * and publishes every 2 s.
   */
  readonly updates$: Observable<ContainersUpdate> = defer(() => {
    const run = this.begin();
    const refreshes$ = merge(
      of(undefined),
      interval(REFRESH_INTERVAL_MS),
      // Events come in bursts (stop → die → stop): one refresh for the burst.
      run.eventNotices.pipe(auditTime(EVENT_DEBOUNCE_MS)),
    ).pipe(
      tap(() => void this.refresh(run)),
      ignoreElements(),
    );
    const publishes$ = interval(PUBLISH_INTERVAL_MS).pipe(
      map(() => this.update(run)),
      filter((update): update is ContainersUpdate => update !== null),
    );
    return merge(refreshes$, publishes$).pipe(finalize(() => this.end(run)));
  }).pipe(share());

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

  /** Waits for the first refresh when collecting has only just started. */
  async snapshot(): Promise<ContainersSnapshot> {
    const run = this.run;
    if (!run) throw new Error('Containers are not being monitored');
    if (run.dockerAvailable === null) await firstValueFrom(run.answered$);
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

  private begin(): Run {
    const run: Run = {
      dockerAvailable: null,
      containers: [],
      stats: new Map(),
      statsStreams: new Map(),
      events: null,
      eventNotices: new Subject(),
      refreshing: null,
      refreshAgain: false,
      answered$: new ReplaySubject(1),
    };
    this.run = run;
    return run;
  }

  private end(run: Run): void {
    if (this.run === run) this.run = null;
    this.closeStreams(run);
    run.answered$.error(new Error('Container monitoring stopped'));
  }

  /** One refresh at a time; a request during one runs once more after it. */
  private refresh(run: Run): Promise<void> {
    if (run.refreshing) {
      run.refreshAgain = true;
      return run.refreshing;
    }
    run.refreshing = (async () => {
      try {
        do {
          run.refreshAgain = false;
          await this.refreshOnce(run);
        } while (run.refreshAgain && run === this.run);
      } catch (error) {
        this.logger.error('Refreshing the containers failed', (error as Error).stack);
      } finally {
        run.refreshing = null;
      }
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
    run.answered$.next();
  }

  /** A stats stream for every running container, and none for anything else. */
  private syncStatsStreams(run: Run): void {
    const running = new Set(run.containers.filter((c) => c.state === 'running').map((c) => c.id));
    for (const [id, stream] of run.statsStreams) {
      if (running.has(id)) continue;
      stream.unsubscribe();
      run.statsStreams.delete(id);
      run.stats.delete(id);
    }
    for (const id of running) {
      if (!run.statsStreams.has(id)) this.openStats(run, id);
    }
  }

  private openStats(run: Run, id: string): void {
    const stream = fromAbortable((signal) => this.docker.containerStats(id, signal)).subscribe({
      next: (stats) => run.stats.set(id, stats),
      error: (error: unknown) =>
        this.logger.debug(`Stats stream for ${id} ended: ${(error as Error).message}`),
    });
    run.statsStreams.set(id, stream);
    // Ended by itself (container stopped, Docker restarted): the next refresh decides.
    stream.add(() => {
      if (run.statsStreams.get(id) === stream) run.statsStreams.delete(id);
    });
  }

  private openEvents(run: Run): void {
    const events = fromAbortable((signal) => this.docker.containerEvents(signal)).subscribe({
      next: () => run.eventNotices.next(),
      error: (error: unknown) =>
        this.logger.debug(`Docker events stream ended: ${(error as Error).message}`),
    });
    run.events = events;
    events.add(() => {
      if (run.events === events) run.events = null; // reopened at the next refresh
    });
  }

  private closeStreams(run: Run): void {
    for (const stream of run.statsStreams.values()) stream.unsubscribe();
    run.statsStreams.clear();
    run.events?.unsubscribe();
    run.events = null;
  }

  /** The update to publish — none until the first refresh has answered. */
  private update(run: Run): ContainersUpdate | null {
    if (run.dockerAvailable === null) return null;
    if (!run.dockerAvailable) return { dockerAvailable: false };
    const containers = this.withStats(run);
    for (const { id, stats } of containers) {
      if (stats) this.recordHistory(id, stats);
    }
    return { dockerAvailable: true, containers };
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
