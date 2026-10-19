import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import type { AuthenticationEvents } from '@nestjs/authentication';
import type { Response } from 'express';
import { Subject } from 'rxjs';
import { type ContainerState, LOG_LIMITS, type LogLine } from '@homelab/shared';
import { ContainerLogsError, type DockerService } from '../docker/docker.service.js';
import { ContainerLogStreams } from './container-log-streams.js';
import {
  HEARTBEAT_MS,
  MAX_BATCH_LINES,
  MAX_RESPONSE_MS,
  RETRY_MS,
  STOP_GRACE_MS,
} from './container-logs.constants.js';
import type { LogsRequest, LogViewer } from './container-logs.model.js';

function line(i: number, text = `line ${i}`): LogLine {
  return { at: `2026-10-11T12:00:00.${String(i).padStart(9, '0')}Z`, stream: 'stdout', text };
}

interface SseEvent {
  event?: string;
  id?: string;
  data?: unknown;
  retry?: number;
  comment?: true;
}

/** A response the test reads back as events; `full` makes writes back up until `drain()`. */
class FakeResponse extends EventEmitter {
  statusCode = 0;
  headers: Record<string, string> = {};
  text = '';
  writableEnded = false;
  writableNeedDrain = false;
  destroyed = false;
  full = false;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }
  set(headers: Record<string, string>): this {
    Object.assign(this.headers, headers);
    return this;
  }
  flushHeaders(): void {}
  write(chunk: string): boolean {
    this.text += chunk;
    if (this.full) this.writableNeedDrain = true;
    return !this.full;
  }
  end(): void {
    this.writableEnded = true;
    this.emit('close');
  }
  drain(): void {
    this.full = false;
    this.writableNeedDrain = false;
    this.emit('drain');
  }
  /** The browser went away. */
  close(): void {
    this.destroyed = true;
    this.emit('close');
  }

  get events(): SseEvent[] {
    return this.text
      .split('\n\n')
      .filter(Boolean)
      .map((block) => {
        const event: SseEvent = {};
        for (const field of block.split('\n')) {
          if (field.startsWith(':')) event.comment = true;
          const [, key, value] = /^(\w+): (.*)$/.exec(field) ?? [];
          if (key === 'event') event.event = value;
          if (key === 'id') event.id = value;
          if (key === 'data') event.data = JSON.parse(value);
          if (key === 'retry') event.retry = Number(value);
        }
        return event;
      });
  }
  /** Every line received, in order. */
  get lines(): LogLine[] {
    return this.events.flatMap((e) =>
      e.event === 'lines' ? (e.data as { lines: LogLine[] }).lines : [],
    );
  }
  get ends(): unknown[] {
    return this.events.filter((e) => e.event === 'end').map((e) => e.data);
  }
}

/** One `containerLogs()` call: lines are fed in by the test; ends, fails or is aborted. */
class Feed {
  private readonly queue: (LogLine | { end: true } | { error: unknown })[] = [];
  private wake: (() => void) | null = null;
  /** Lines the reader has taken. */
  read = 0;

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
      this.read++;
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

const viewer: LogViewer = { sessionId: 's1', userId: 'u1' };

describe('ContainerLogStreams', () => {
  let docker: FakeDocker;
  let authEvents: Subject<unknown>;
  let streams: ContainerLogStreams;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    docker = new FakeDocker();
    authEvents = new Subject();
    streams = new ContainerLogStreams(
      docker as unknown as DockerService,
      {
        events$: authEvents,
      } as unknown as AuthenticationEvents,
    );
    streams.onModuleInit();
  });

  afterEach(() => {
    streams.onModuleDestroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Lets the streams' async work and timers run. */
  const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

  function serve(request: Partial<LogsRequest> = {}, who = viewer) {
    const res = new FakeResponse();
    const done = streams.serve(
      res as unknown as Response,
      { name: 'web', tail: LOG_LIMITS.defaultTail, ...request },
      who,
    );
    return { res, done };
  }

  it('answers as an event stream, the reconnect delay first', async () => {
    const { res } = serve();
    await tick();
    expect(res.statusCode).toBe(200);
    expect(res.headers).toEqual({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Accel-Buffering': 'no',
    });
    expect(res.events[0]).toEqual({ retry: RETRY_MS });
  });

  it('asks Docker for the tail and sends what arrives together as one event, its id the last line’s time', async () => {
    const { res } = serve({ tail: 100 });
    await tick();
    expect(docker.last.name).toBe('web');
    expect(docker.last.options).toEqual({ tail: 100 });

    docker.last.push(line(1), line(2), line(3));
    await tick();
    docker.last.push(line(4));
    await tick();
    const events = res.events.filter((e) => e.event === 'lines');
    expect(events).toEqual([
      { event: 'lines', id: line(3).at, data: { lines: [line(1), line(2), line(3)] } },
      { event: 'lines', id: line(4).at, data: { lines: [line(4)] } },
    ]);
  });

  it('splits a burst into events of at most MAX_BATCH_LINES', async () => {
    const { res } = serve();
    await tick();
    const burst = Array.from({ length: MAX_BATCH_LINES + 1 }, (_, i) => line(i));
    docker.last.push(...burst);
    await tick();
    const sizes = res.events
      .filter((e) => e.event === 'lines')
      .map((e) => (e.data as { lines: unknown[] }).lines.length);
    expect(sizes).toEqual([MAX_BATCH_LINES, 1]);
    expect(res.lines).toEqual(burst);
  });

  it('resumes after `since` (a Last-Event-ID or the query), as much as Docker gives at once', async () => {
    serve({ tail: 100, since: line(5).at });
    await tick();
    expect(docker.last.options).toEqual({ tail: LOG_LIMITS.maxTail, since: line(5).at });
  });

  it('ends the response quietly when Docker ends the stream of a still running container', async () => {
    const { res, done } = serve();
    await tick();
    docker.last.push(line(1));
    docker.state = 'running';
    docker.last.end();
    await done;
    expect(docker.containerState).toHaveBeenCalledWith('web');
    expect(res.ends).toEqual([]);
    expect(res.lines).toEqual([line(1)]); // the last lines before the end
    expect(res.writableEnded).toBe(true);
    expect(streams.openCount).toBe(0);
  });

  it.each([
    ['exited', 'stopped'],
    ['dead', 'stopped'],
    [null, 'removed'],
    [new Error('Docker unreachable'), 'error'],
  ] as const)('a stream that ends with the container %s: end %s', async (state, reason) => {
    const { res, done } = serve();
    await tick();
    docker.last.push(line(1));
    docker.state = state;
    docker.last.end();
    await tick(STOP_GRACE_MS - 1);
    expect(res.ends).toEqual([]); // asked again after a moment
    await tick(1);
    await done;
    expect(docker.containerState).toHaveBeenCalledTimes(2);
    expect(res.lines).toEqual([line(1)]);
    expect(res.ends).toEqual([{ reason }]);
    expect(res.events.at(-1)).toMatchObject({ event: 'end' });
    expect(res.writableEnded).toBe(true);
  });

  it('ends the response quietly for a restart: stopped at first, running a moment later', async () => {
    const { res, done } = serve();
    await tick();
    docker.state = 'exited';
    docker.last.end();
    await tick();
    docker.state = 'running';
    await tick(STOP_GRACE_MS);
    await done;
    expect(res.ends).toEqual([]);
    expect(res.writableEnded).toBe(true);
  });

  it('ends without an event when the browser leaves during the moment', async () => {
    const { res, done } = serve();
    await tick();
    docker.last.end();
    await tick();
    res.close();
    await done;
    expect(docker.containerState).toHaveBeenCalledTimes(1);
    expect(res.ends).toEqual([]);
  });

  it.each([
    [new ContainerLogsError('not_found'), {}, 'not_found'],
    [new ContainerLogsError('not_found'), { since: line(1).at }, 'removed'],
    [new ContainerLogsError('unavailable'), {}, 'unavailable'],
    [new Error('connect ECONNREFUSED'), {}, 'error'],
  ] as const)('Docker refusing with %s (%o): end %s', async (error, request, reason) => {
    const { res, done } = serve(request);
    await tick();
    docker.last.fail(error);
    await done;
    expect(res.ends).toEqual([{ reason }]);
    expect(docker.containerState).not.toHaveBeenCalled();
  });

  it('stops reading from Docker while the browser isn’t taking what was written', async () => {
    const { res } = serve();
    await tick();
    res.full = true;
    docker.last.push(...Array.from({ length: 2 * MAX_BATCH_LINES }, (_, i) => line(i)));
    await tick();
    // One batch written into a full buffer, then waiting.
    expect(docker.last.read).toBe(MAX_BATCH_LINES);
    await tick(60_000);
    expect(docker.last.read).toBe(MAX_BATCH_LINES);

    res.drain();
    await tick();
    expect(docker.last.read).toBe(2 * MAX_BATCH_LINES);
    expect(res.lines).toHaveLength(2 * MAX_BATCH_LINES);
  });

  it('stops the Docker stream when the browser goes away', async () => {
    const { res, done } = serve();
    await tick();
    res.close();
    await done;
    expect(docker.last.signal.aborted).toBe(true);
    expect(streams.openCount).toBe(0);
    expect(res.ends).toEqual([]);
  });

  it(`refuses a ${LOG_LIMITS.maxStreamsPerSession + 1}th stream of a session with end too_many; one closing makes room`, async () => {
    const open = Array.from({ length: LOG_LIMITS.maxStreamsPerSession }, () => serve());
    await tick();
    expect(streams.openCount).toBe(LOG_LIMITS.maxStreamsPerSession);

    const refused = serve();
    await refused.done;
    expect(refused.res.ends).toEqual([{ reason: 'too_many' }]);
    expect(refused.res.writableEnded).toBe(true);
    expect(docker.feeds).toHaveLength(LOG_LIMITS.maxStreamsPerSession);

    // Another sign-in has its own.
    serve({}, { sessionId: 's2', userId: 'u1' });
    await tick();
    expect(streams.openCount).toBe(LOG_LIMITS.maxStreamsPerSession + 1);

    open[0].res.close();
    await open[0].done;
    const again = serve();
    await tick();
    expect(again.res.ends).toEqual([]);
    expect(streams.openCount).toBe(LOG_LIMITS.maxStreamsPerSession + 1);
  });

  it('lets a resumed view in at the limit: its dropped connection may still be counted', async () => {
    for (let i = 0; i < LOG_LIMITS.maxStreamsPerSession; i++) serve();
    await tick();
    const resumed = serve({ since: line(1).at });
    await tick();
    expect(resumed.res.ends).toEqual([]);
    expect(streams.openCount).toBe(LOG_LIMITS.maxStreamsPerSession + 1);
  });

  it('ends a response after MAX_RESPONSE_MS without an end event, so the reconnect checks the session', async () => {
    const { res, done } = serve();
    await tick(MAX_RESPONSE_MS - 1);
    expect(res.writableEnded).toBe(false);
    await tick(1);
    await done;
    expect(docker.last.signal.aborted).toBe(true);
    expect(res.ends).toEqual([]);
    expect(res.writableEnded).toBe(true);
  });

  it('sends a comment every HEARTBEAT_MS while quiet', async () => {
    const { res } = serve();
    await tick(2 * HEARTBEAT_MS);
    expect(res.events.filter((e) => e.comment)).toHaveLength(2);
  });

  it('ends the signed-out session’s streams at once, and all of a user’s for "everywhere"', async () => {
    const mine = serve();
    const otherSession = serve({}, { sessionId: 's2', userId: 'u1' });
    const otherUser = serve({}, { sessionId: 's3', userId: 'u2' });
    await tick();

    authEvents.next({ type: 'sign-out', sessionId: 's1', userId: 'u1', everywhere: false });
    await mine.done;
    expect(mine.res.writableEnded).toBe(true);
    expect(streams.openCount).toBe(2);

    authEvents.next({ type: 'sign-out', userId: 'u1', everywhere: true });
    await otherSession.done;
    expect(streams.openCount).toBe(1);
    expect(otherUser.res.writableEnded).toBe(false);
  });

  it('ends every stream on shutdown', async () => {
    const { done } = serve();
    await tick();
    streams.onModuleDestroy();
    await done;
    expect(streams.openCount).toBe(0);
  });
});
