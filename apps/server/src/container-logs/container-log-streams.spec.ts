import { Logger } from '@nestjs/common';
import { type ContainerState, LOG_LIMITS, type LogLine, type ServerMessage } from '@homelab/shared';
import { WebSocket } from 'ws';
import { ContainerLogsError, type DockerService } from '../docker/docker.service.js';
import { RealtimeLogStreams } from '../realtime/realtime-log-streams.js';
import { RealtimeException, type RealtimeClient } from '../realtime/realtime-messages.js';
import {
  ContainerLogStreams,
  MAX_BATCH_BYTES,
  MAX_BATCH_LINES,
  REOPEN_DELAY_MS,
} from './container-log-streams.js';

const BATCH_MS = LOG_LIMITS.batchIntervalMs;

function line(i: number, text = `line ${i}`): LogLine {
  return { at: `2026-10-11T12:00:00.${String(i).padStart(9, '0')}Z`, stream: 'stdout', text };
}

class FakeClient implements RealtimeClient {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  readonly sent: ServerMessage[] = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerMessage);
  }
  get events(): string[] {
    return this.sent.map((message) => message.event);
  }
  /** Every line received, in order. */
  get lines(): LogLine[] {
    return this.sent.flatMap((message) =>
      message.event === 'logs:lines' ? message.data.lines : [],
    );
  }
}

/** One `containerLogs()` call: lines are fed in by the test; ends, fails or is aborted. */
class Feed {
  private readonly queue: (LogLine | { end: true } | { error: unknown })[] = [];
  private wake: (() => void) | null = null;

  constructor(
    readonly name: string,
    readonly options: { tail?: number; since?: string },
    readonly signal: AbortSignal,
  ) {
    signal.addEventListener('abort', () => this.wake?.());
  }

  push(...lines: LogLine[]): void {
    this.queue.push(...lines);
    this.wake?.();
  }
  end(): void {
    this.queue.push({ end: true });
    this.wake?.();
  }
  fail(error: unknown): void {
    this.queue.push({ error });
    this.wake?.();
  }

  async *iterate(): AsyncGenerator<LogLine> {
    for (;;) {
      if (this.signal.aborted) throw new DOMException('aborted', 'AbortError');
      const item = this.queue.shift();
      if (!item) {
        await new Promise<void>((resolve) => (this.wake = resolve));
        continue;
      }
      if ('end' in item) return;
      if ('error' in item) throw item.error;
      yield item;
    }
  }
}

class FakeDocker {
  readonly feeds: Feed[] = [];
  state: ContainerState | null | Error = 'exited';
  containerLogs(
    name: string,
    options: { tail?: number; since?: string },
    signal: AbortSignal,
  ): AsyncGenerator<LogLine> {
    const feed = new Feed(name, options, signal);
    this.feeds.push(feed);
    return feed.iterate();
  }
  containerState = vi.fn(async () => {
    if (this.state instanceof Error) throw this.state;
    return this.state;
  });
  get last(): Feed {
    return this.feeds.at(-1)!;
  }
}

describe('ContainerLogStreams', () => {
  let docker: FakeDocker;
  let streams: ContainerLogStreams;
  let client: FakeClient;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    docker = new FakeDocker();
    streams = new ContainerLogStreams(docker as unknown as DockerService, new RealtimeLogStreams());
    client = new FakeClient();
  });

  afterEach(() => {
    streams.onModuleDestroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Lets the streams' async work and timers run. */
  const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

  it('registers itself as the gateway’s log stream handler', () => {
    const registry = new RealtimeLogStreams();
    const own = new ContainerLogStreams(docker as unknown as DockerService, registry);
    expect(() => registry.register(own)).toThrow(/already registered/);
  });

  it('asks Docker for the requested tail and sends the history as one batch', async () => {
    streams.open(client, { container: 'web', tail: 100 });
    expect(docker.last).toMatchObject({ name: 'web', options: { tail: 100 } });
    docker.last.push(line(1), line(2), line(3));
    await tick();
    expect(client.sent).toEqual([
      { event: 'logs:lines', data: { container: 'web', lines: [line(1), line(2), line(3)] } },
    ]);
  });

  it('passes since on to Docker when resuming', () => {
    streams.open(client, { container: 'web', tail: 500, since: line(7).at });
    expect(docker.last.options).toEqual({ tail: 500, since: line(7).at });
  });

  it('sends at most one batch per interval', async () => {
    streams.open(client, { container: 'web', tail: 10 });
    docker.last.push(line(1));
    await tick();
    docker.last.push(line(2));
    await tick();
    docker.last.push(line(3));
    await tick(BATCH_MS - 1);
    expect(client.lines).toEqual([line(1)]);
    await tick(1);
    expect(client.sent).toHaveLength(2);
    expect(client.lines).toEqual([line(1), line(2), line(3)]);
  });

  it('caps a flood per batch and counts the rest as skipped', async () => {
    streams.open(client, { container: 'web', tail: 10 });
    const flood = Array.from({ length: 10_000 }, (_, i) => line(i));
    docker.last.push(...flood);
    await tick();
    expect(client.sent).toHaveLength(1);
    const [first] = client.sent as Extract<ServerMessage, { event: 'logs:lines' }>[];
    expect(first.data.lines).toEqual(flood.slice(0, MAX_BATCH_LINES));
    expect(first.data.skipped).toBe(10_000 - MAX_BATCH_LINES);

    // The flood is over: the next batch is complete again.
    docker.last.push(line(20_000));
    await tick(BATCH_MS);
    expect(client.sent[1]).toEqual({
      event: 'logs:lines',
      data: { container: 'web', lines: [line(20_000)] },
    });
  });

  it('caps a batch by size, too', async () => {
    streams.open(client, { container: 'web', tail: 10 });
    const big = 'x'.repeat(LOG_LIMITS.maxLineBytes);
    const count = MAX_BATCH_BYTES / LOG_LIMITS.maxLineBytes + 5;
    docker.last.push(...Array.from({ length: count }, (_, i) => line(i, big)));
    await tick();
    const [first] = client.sent as Extract<ServerMessage, { event: 'logs:lines' }>[];
    expect(first.data.lines).toHaveLength(MAX_BATCH_BYTES / LOG_LIMITS.maxLineBytes);
    expect(first.data.skipped).toBe(5);
  });

  it('counts lines as skipped while the client is backed up, and reports them after', async () => {
    streams.open(client, { container: 'web', tail: 10 });
    client.bufferedAmount = 10 * 1024 * 1024;
    docker.last.push(line(1), line(2));
    await tick(BATCH_MS);
    docker.last.push(line(3));
    await tick(BATCH_MS);
    expect(client.sent).toEqual([]);

    client.bufferedAmount = 0;
    await tick(BATCH_MS);
    expect(client.sent).toEqual([
      { event: 'logs:lines', data: { container: 'web', lines: [], skipped: 3 } },
    ]);
    docker.last.push(line(4));
    await tick(BATCH_MS);
    expect(client.lines).toEqual([line(4)]);
  });

  it('closes the Docker stream on logs:close, and sends nothing more', async () => {
    streams.open(client, { container: 'web', tail: 10 });
    const feed = docker.last;
    feed.push(line(1));
    streams.close(client, { container: 'web' });
    await tick(BATCH_MS);
    expect(feed.signal.aborted).toBe(true);
    expect(client.sent).toEqual([]);
    expect(streams.openCount).toBe(0);
    streams.close(client, { container: 'web' }); // idempotent
    streams.close(client, { container: 'never-opened' });
  });

  it('closes every stream of a client that disconnects (also how a sign-out ends them)', async () => {
    const other = new FakeClient();
    streams.open(client, { container: 'a', tail: 10 });
    streams.open(client, { container: 'b', tail: 10 });
    streams.open(other, { container: 'a', tail: 10 });
    const [a, b, otherA] = docker.feeds;
    streams.removeClient(client);
    await tick();
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
    expect(otherA.signal.aborted).toBe(false);
    expect(streams.openCount).toBe(1);
  });

  it('closes everything on shutdown', () => {
    streams.open(client, { container: 'a', tail: 10 });
    streams.open(new FakeClient(), { container: 'b', tail: 10 });
    streams.onModuleDestroy();
    expect(docker.feeds.every((feed) => feed.signal.aborted)).toBe(true);
    expect(streams.openCount).toBe(0);
  });

  it('allows 3 streams per connection; a 4th is refused with too_many_streams', () => {
    for (const container of ['a', 'b', 'c']) streams.open(client, { container, tail: 10 });
    expect(() => streams.open(client, { container: 'd', tail: 10 })).toThrow(
      RealtimeException.tooManyStreams(),
    );
    expect(docker.feeds).toHaveLength(3);

    // Re-opening one of the three doesn't count twice; closing one makes room.
    streams.open(client, { container: 'a', tail: 10 });
    streams.close(client, { container: 'b' });
    streams.open(client, { container: 'd', tail: 10 });
    expect(streams.openCount).toBe(3);
    // Another connection has its own limit.
    streams.open(new FakeClient(), { container: 'a', tail: 10 });
  });

  it('replaces the stream when a viewer re-opens the same container', async () => {
    streams.open(client, { container: 'web', tail: 10 });
    const old = docker.last;
    streams.open(client, { container: 'web', tail: 10, since: line(5).at });
    old.push(line(1)); // too late: aborted
    docker.last.push(line(6));
    await tick();
    expect(old.signal.aborted).toBe(true);
    expect(client.lines).toEqual([line(6)]);
    expect(streams.openCount).toBe(1);
  });

  describe('when the stream ends', () => {
    it('sends the last lines, then logs:end stopped, for a stopped container', async () => {
      docker.state = 'exited';
      streams.open(client, { container: 'web', tail: 10 });
      docker.last.push(line(1));
      await tick();
      docker.last.push(line(2));
      docker.last.end();
      await tick();
      expect(client.events).toEqual(['logs:lines', 'logs:lines', 'logs:end']);
      expect(client.lines).toEqual([line(1), line(2)]); // not held back by the interval
      expect(client.sent.at(-1)).toEqual({
        event: 'logs:end',
        data: { container: 'web', reason: 'stopped' },
      });
      expect(streams.openCount).toBe(0);
    });

    it('sends logs:end removed when the container is gone', async () => {
      docker.state = null;
      streams.open(client, { container: 'web', tail: 10 });
      docker.last.end();
      await tick();
      expect(client.sent).toEqual([
        { event: 'logs:end', data: { container: 'web', reason: 'removed' } },
      ]);
    });

    it('re-opens quietly where it left off while the container still runs', async () => {
      docker.state = 'running';
      streams.open(client, { container: 'web', tail: 10 });
      docker.last.push(line(1), line(2));
      docker.last.end(); // e.g. an hour without output: the proxy's timeout
      await tick(REOPEN_DELAY_MS - 1);
      expect(docker.feeds).toHaveLength(1);
      await tick(1);
      expect(docker.feeds).toHaveLength(2);
      expect(docker.last.options).toEqual({ since: line(2).at });
      docker.last.push(line(3));
      await tick(BATCH_MS);
      expect(client.lines).toEqual([line(1), line(2), line(3)]);
      expect(client.events).not.toContain('logs:end');
    });

    it('re-opens from when it was opened if no line had arrived yet', async () => {
      vi.setSystemTime(new Date('2026-10-11T12:00:00.000Z'));
      docker.state = 'running';
      streams.open(client, { container: 'web', tail: 10 });
      docker.last.end();
      await tick(REOPEN_DELAY_MS);
      expect(docker.last.options).toEqual({ since: '2026-10-11T12:00:00.000000000Z' });
    });

    it('doesn’t re-open a stream closed during the wait', async () => {
      docker.state = 'running';
      streams.open(client, { container: 'web', tail: 10 });
      docker.last.end();
      await tick();
      streams.close(client, { container: 'web' });
      await tick(REOPEN_DELAY_MS);
      expect(docker.feeds).toHaveLength(1);
      expect(client.sent).toEqual([]);
    });

    it('reports not_found and unavailable as such', async () => {
      streams.open(client, { container: 'nope', tail: 10 });
      docker.last.fail(new ContainerLogsError('not_found'));
      streams.open(client, { container: 'silent', tail: 10 });
      docker.last.fail(new ContainerLogsError('unavailable'));
      await tick();
      expect(client.sent).toEqual([
        { event: 'logs:end', data: { container: 'nope', reason: 'not_found' } },
        { event: 'logs:end', data: { container: 'silent', reason: 'unavailable' } },
      ]);
      expect(streams.openCount).toBe(0);
    });

    it('reports a container that disappears between re-opens as removed', async () => {
      docker.state = 'running';
      streams.open(client, { container: 'web', tail: 10 });
      docker.last.end();
      await tick(REOPEN_DELAY_MS);
      docker.last.fail(new ContainerLogsError('not_found'));
      await tick();
      expect(client.sent).toEqual([
        { event: 'logs:end', data: { container: 'web', reason: 'removed' } },
      ]);
    });

    it('reports Docker failures as error, after the lines it had', async () => {
      streams.open(client, { container: 'web', tail: 10 });
      docker.last.push(line(1));
      docker.last.fail(new Error('connect ECONNREFUSED'));
      await tick();
      expect(client.sent).toEqual([
        { event: 'logs:lines', data: { container: 'web', lines: [line(1)] } },
        { event: 'logs:end', data: { container: 'web', reason: 'error' } },
      ]);
    });

    it('reports error when the state can’t be checked', async () => {
      docker.state = new Error('Docker gone');
      streams.open(client, { container: 'web', tail: 10 });
      docker.last.end();
      await tick();
      expect(client.sent).toEqual([
        { event: 'logs:end', data: { container: 'web', reason: 'error' } },
      ]);
    });

    it('sends logs:end even to a backed-up client', async () => {
      streams.open(client, { container: 'web', tail: 10 });
      client.bufferedAmount = 10 * 1024 * 1024;
      docker.last.push(line(1));
      docker.last.end();
      await tick();
      expect(client.events).toEqual(['logs:end']);
    });

    it('sends nothing to a closed socket', async () => {
      streams.open(client, { container: 'web', tail: 10 });
      client.readyState = WebSocket.CLOSED;
      docker.last.push(line(1));
      docker.last.end();
      await tick(BATCH_MS);
      expect(client.sent).toEqual([]);
    });
  });
});
