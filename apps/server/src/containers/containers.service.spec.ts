import { Logger } from '@nestjs/common';
import { type ContainerStats, type ContainersUpdate, HISTORY_WINDOW_MS } from '@ilex/shared';
import type { Subscription } from 'rxjs';
import type { DockerService } from '../docker/docker.service.js';
import { RealtimeSubscriptions } from '../realtime/realtime-subscriptions.js';
import {
  ContainersService,
  EVENT_DEBOUNCE_MS,
  PUBLISH_INTERVAL_MS,
  REFRESH_INTERVAL_MS,
} from './containers.service.js';
import type { DockerContainer, DockerContainerEvent } from '../docker/docker.model.js';

/** A stream the test feeds; ends when its signal aborts (or `end()`), counting open ones. */
class FakeStream<T> {
  static open = 0;
  private queue: T[] = [];
  private wake: (() => void) | null = null;
  private ended = false;

  async *iterate(signal: AbortSignal): AsyncGenerator<T> {
    FakeStream.open++;
    try {
      while (!signal.aborted && !this.ended) {
        const next = this.queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          this.wake = resolve;
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      }
    } finally {
      FakeStream.open--;
    }
  }

  push(item: T): void {
    this.queue.push(item);
    this.wake?.();
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }
}

const container = (id: string, state: DockerContainer['state'] = 'running'): DockerContainer => ({
  id,
  name: id,
  image: `${id}:latest`,
  state,
  health: 'none',
  startedAt: state === 'running' ? '2026-10-11T12:00:00.000Z' : null,
  ports: [],
  protected: false,
  composeProject: null,
  composeWorkingDir: null,
  template: null,
});

const stats = (cpuPercent: number): ContainerStats => ({
  at: Date.now(),
  cpuPercent,
  memoryUsedBytes: 1000,
  memoryLimitBytes: 4000,
  netRxBytes: 0,
  netTxBytes: 0,
  blockReadBytes: 0,
  blockWriteBytes: 0,
});

class FakeDocker {
  containers: DockerContainer[] = [container('web'), container('db'), container('old', 'exited')];
  reachable = true;
  listCalls = 0;
  readonly stats = new Map<string, FakeStream<ContainerStats>>();
  events = new FakeStream<DockerContainerEvent>();
  statsOpened: string[] = [];

  async listContainers(): Promise<DockerContainer[]> {
    this.listCalls++;
    if (!this.reachable) throw new Error('connect ECONNREFUSED 127.0.0.1:2375');
    return this.containers.map((c) => ({ ...c }));
  }

  containerStats(id: string, signal: AbortSignal): AsyncGenerator<ContainerStats> {
    const stream = new FakeStream<ContainerStats>();
    this.stats.set(id, stream);
    this.statsOpened.push(id);
    return stream.iterate(signal);
  }

  containerEvents(signal: AbortSignal): AsyncGenerator<DockerContainerEvent> {
    return this.events.iterate(signal);
  }
}

describe('ContainersService', () => {
  let docker: FakeDocker;
  let service: ContainersService;
  let published: ContainersUpdate[];
  let subscription: Subscription | undefined;
  const start = () =>
    (subscription = service.updates$.subscribe((update) => published.push(update)));
  const stop = () => subscription?.unsubscribe();
  const latest = () => published.at(-1)!;
  const containersOf = (update: ContainersUpdate) =>
    update.dockerAvailable ? update.containers : [];

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-10-11T12:00:00Z') });
    FakeStream.open = 0;
    docker = new FakeDocker();
    service = new ContainersService(
      docker as unknown as DockerService,
      new RealtimeSubscriptions(),
    );
    published = [];
  });

  afterEach(() => {
    stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('asks Docker nothing until started', async () => {
    await vi.advanceTimersByTimeAsync(3 * REFRESH_INTERVAL_MS);
    expect(docker.listCalls).toBe(0);
    expect(FakeStream.open).toBe(0);
  });

  it('opens one stats stream per running container, plus the events stream', async () => {
    start();
    await vi.advanceTimersByTimeAsync(0);
    expect(docker.statsOpened.sort()).toEqual(['db', 'web']);
    expect(service.openStreams).toBe(3);
    expect(FakeStream.open).toBe(3);
  });

  it('snapshot: waits for the first list, then containers without stats yet', async () => {
    start();
    const snapshot = await service.snapshot();
    expect(snapshot).toEqual({
      dockerAvailable: true,
      containers: docker.containers.map((c) => ({ ...c, stats: null })),
      history: {},
    });
  });

  it('publishes every 2 s with the latest stats of running containers', async () => {
    start();
    await vi.advanceTimersByTimeAsync(0);
    docker.stats.get('web')!.push(stats(10));
    docker.stats.get('web')!.push(stats(30));
    await vi.advanceTimersByTimeAsync(PUBLISH_INTERVAL_MS);
    expect(published).toHaveLength(1);
    const byId = new Map(containersOf(latest()).map((c) => [c.id, c]));
    expect(byId.get('web')!.stats!.cpuPercent).toBe(30);
    expect(byId.get('db')!.stats).toBeNull();
    expect(byId.get('old')!.stats).toBeNull();
  });

  it('records one history point per new stats frame, sent with the snapshot', async () => {
    start();
    await vi.advanceTimersByTimeAsync(0);
    docker.stats.get('web')!.push(stats(10));
    await vi.advanceTimersByTimeAsync(PUBLISH_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(PUBLISH_INTERVAL_MS); // no new frame: no new point
    docker.stats.get('web')!.push(stats(20));
    await vi.advanceTimersByTimeAsync(PUBLISH_INTERVAL_MS);
    const snapshot = await service.snapshot();
    expect(snapshot.dockerAvailable && snapshot.history).toEqual({
      web: [
        { at: expect.any(Number), cpuPercent: 10, memoryUsedBytes: 1000 },
        { at: expect.any(Number), cpuPercent: 20, memoryUsedBytes: 1000 },
      ],
    });
  });

  it('refreshes once per burst of events', async () => {
    start();
    await vi.advanceTimersByTimeAsync(0);
    const calls = docker.listCalls;
    docker.containers[0] = container('web', 'exited');
    for (const action of ['kill', 'die', 'stop'])
      docker.events.push({
        containerId: 'web',
        action,
        name: 'web',
        composeProject: null,
        protected: false,
      });
    await vi.advanceTimersByTimeAsync(EVENT_DEBOUNCE_MS);
    expect(docker.listCalls).toBe(calls + 1);
    await vi.advanceTimersByTimeAsync(PUBLISH_INTERVAL_MS);
    expect(containersOf(latest()).find((c) => c.id === 'web')!.state).toBe('exited');
  });

  it('closes the stats stream of a container that stopped, keeping its history', async () => {
    start();
    await vi.advanceTimersByTimeAsync(0);
    docker.stats.get('web')!.push(stats(10));
    await vi.advanceTimersByTimeAsync(PUBLISH_INTERVAL_MS);
    docker.containers[0] = container('web', 'exited');
    await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS);
    expect(service.openStreams).toBe(2); // db + events
    expect(FakeStream.open).toBe(2);
    const snapshot = await service.snapshot();
    expect(snapshot.dockerAvailable && Object.keys(snapshot.history)).toEqual(['web']);
  });

  it('drops the history of a removed container', async () => {
    start();
    await vi.advanceTimersByTimeAsync(0);
    docker.stats.get('web')!.push(stats(10));
    await vi.advanceTimersByTimeAsync(PUBLISH_INTERVAL_MS);
    docker.containers = docker.containers.filter((c) => c.id !== 'web');
    await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS);
    const snapshot = await service.snapshot();
    expect(snapshot.dockerAvailable && snapshot.history).toEqual({});
  });

  it('opens a stream for a container that started, and reopens one that ended by itself', async () => {
    start();
    await vi.advanceTimersByTimeAsync(0);
    docker.containers[2] = container('old', 'running');
    docker.stats.get('db')!.end();
    await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS);
    expect(docker.statsOpened.filter((id) => id === 'old')).toHaveLength(1);
    expect(docker.statsOpened.filter((id) => id === 'db')).toHaveLength(2);
    expect(FakeStream.open).toBe(4);
  });

  it('reopens the events stream at the next refresh when it ends', async () => {
    start();
    await vi.advanceTimersByTimeAsync(0);
    docker.events.end();
    docker.events = new FakeStream<DockerContainerEvent>();
    await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS);
    expect(service.openStreams).toBe(3);
  });

  it('closes every stream when unsubscribed, leaving no timers, and asks Docker nothing more', async () => {
    start();
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeStream.open).toBe(0);
    expect(service.openStreams).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    const calls = docker.listCalls;
    await vi.advanceTimersByTimeAsync(3 * REFRESH_INTERVAL_MS);
    expect(docker.listCalls).toBe(calls);
    expect(published).toHaveLength(0);
  });

  it('rejects a snapshot when stopped before the first list, and when not collecting', async () => {
    let release!: () => void;
    vi.spyOn(docker, 'listContainers').mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve([]))),
    );
    start();
    const snapshot = service.snapshot();
    stop();
    release();
    await expect(snapshot).rejects.toThrow(/stopped/);
    await expect(service.snapshot()).rejects.toThrow(/not being monitored/);
  });

  describe('Docker not reachable', () => {
    beforeEach(() => {
      docker.reachable = false;
    });

    it('reports it in the snapshot and in updates, with no streams open', async () => {
      const warned = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      start();
      expect(await service.snapshot()).toEqual({ dockerAvailable: false });
      await vi.advanceTimersByTimeAsync(PUBLISH_INTERVAL_MS);
      expect(latest()).toEqual({ dockerAvailable: false });
      expect(FakeStream.open).toBe(0);

      await vi.advanceTimersByTimeAsync(3 * REFRESH_INTERVAL_MS);
      expect(warned).toHaveBeenCalledTimes(1); // once, not every retry
    });

    it('recovers at the next refresh once reachable', async () => {
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      start();
      await vi.advanceTimersByTimeAsync(0);
      docker.reachable = true;
      await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS);
      expect((await service.snapshot()).dockerAvailable).toBe(true);
      expect(FakeStream.open).toBe(3);
    });

    it('closes all streams when Docker goes away', async () => {
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      docker.reachable = true;
      start();
      await vi.advanceTimersByTimeAsync(0);
      docker.reachable = false;
      await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS);
      expect(FakeStream.open).toBe(0);
      expect(latest()).toEqual({ dockerAvailable: false });
    });
  });

  it('keeps at most 15 minutes of history per container', async () => {
    start();
    await vi.advanceTimersByTimeAsync(0);
    for (let elapsed = 0; elapsed < 2 * HISTORY_WINDOW_MS; elapsed += PUBLISH_INTERVAL_MS) {
      docker.stats.get('web')!.push(stats(10));
      await vi.advanceTimersByTimeAsync(PUBLISH_INTERVAL_MS);
    }
    const snapshot = await service.snapshot();
    const history = snapshot.dockerAvailable ? snapshot.history.web : [];
    expect(history).toHaveLength(HISTORY_WINDOW_MS / PUBLISH_INTERVAL_MS);
    expect(history[0].at).toBeGreaterThanOrEqual(Date.now() - HISTORY_WINDOW_MS);
  });

  it('registers itself as the containers topic source', () => {
    const subscriptions = new RealtimeSubscriptions();
    const register = vi.spyOn(subscriptions, 'registerSource');
    const registered = new ContainersService(docker as unknown as DockerService, subscriptions);
    expect(register).toHaveBeenCalledWith(registered);
  });
});
