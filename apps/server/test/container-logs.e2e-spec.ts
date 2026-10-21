import { PasswordHasher } from '@nestjs/authentication';
import type { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  containerLogsPath,
  LOG_LIMITS,
  type LogLine,
  logsEndSchema,
  logsLinesSchema,
} from '@laris/shared';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import type { Env } from '../src/config/env.schema.js';
import { ContainerLogStreams } from '../src/container-logs/container-log-streams.js';
import { DockerService } from '../src/docker/docker.service.js';
import { proxyReachable } from './docker-proxy.js';
import { type SignedIn, signIn, testHasher } from './realtime-client.js';

const POSTGRES = 'laris-dev-postgres-1';
const dockerReachable = await proxyReachable();

type LogsEvent =
  { event: 'lines'; id: string; lines: LogLine[] } | { event: 'end'; reason: string };

/** One log view, as the browser's `EventSource` sees it: its events, checked against the contract. */
class LogsReader {
  readonly events: LogsEvent[] = [];
  /** Resolves once the server has ended the response. */
  readonly ended: Promise<void>;
  private waiters: (() => void)[] = [];

  constructor(
    readonly response: Response,
    private readonly controller: AbortController,
  ) {
    this.ended = this.read().catch(() => {}); // aborted by close()
  }

  get lines(): LogLine[] {
    return this.events.flatMap((e) => (e.event === 'lines' ? e.lines : []));
  }

  /** Resolves once `count` events have arrived in total. */
  async received(count: number, timeoutMs = 3000): Promise<LogsEvent[]> {
    while (this.events.length < count) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Timed out at ${this.events.length}/${count} events`)),
          timeoutMs,
        );
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return this.events;
  }

  /** The browser leaves. */
  close(): void {
    this.controller.abort();
  }

  private async read(): Promise<void> {
    const decoder = new TextDecoder();
    let text = '';
    for await (const chunk of this.response.body!) {
      text += decoder.decode(chunk, { stream: true });
      let end: number;
      while ((end = text.indexOf('\n\n')) >= 0) {
        this.parse(text.slice(0, end));
        text = text.slice(end + 2);
      }
    }
  }

  private parse(block: string): void {
    const fields = new Map<string, string>();
    for (const field of block.split('\n')) {
      const match = /^(\w+): (.*)$/.exec(field);
      if (match) fields.set(match[1], match[2]);
    }
    const data = fields.has('data') ? JSON.parse(fields.get('data')!) : undefined;
    if (fields.get('event') === 'lines') {
      const { lines } = logsLinesSchema.parse(data);
      expect(fields.get('id')).toBe(lines.at(-1)!.at);
      this.events.push({ event: 'lines', id: fields.get('id')!, lines });
    } else if (fields.get('event') === 'end') {
      this.events.push({ event: 'end', ...logsEndSchema.parse(data) });
    } else {
      return; // `retry`, comments
    }
    for (const wake of this.waiters.splice(0)) wake();
  }
}

async function start(docker?: DockerService): Promise<{ app: NestExpressApplication } & SignedIn> {
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PasswordHasher)
    .useValue(testHasher);
  if (docker) builder = builder.overrideProvider(DockerService).useValue(docker);
  const app = configureApp(
    (await builder.compile()).createNestApplication<NestExpressApplication>(),
  );
  return { app, ...(await signIn(app)) };
}

describe('container logs over SSE (e2e)', () => {
  let app: NestExpressApplication;
  let session: SignedIn;
  const readers: LogsReader[] = [];

  async function open(
    name: string,
    { query = '', headers = {} }: { query?: string; headers?: Record<string, string> } = {},
  ): Promise<LogsReader> {
    const controller = new AbortController();
    const response = await fetch(`${session.origin}${containerLogsPath(name)}${query}`, {
      headers: { Cookie: session.cookie, Accept: 'text/event-stream', ...headers },
      signal: controller.signal,
    });
    const reader = new LogsReader(response, controller);
    readers.push(reader);
    return reader;
  }

  afterEach(async () => {
    for (const reader of readers.splice(0)) reader.close();
    await app.close();
  });

  describe('without Docker', () => {
    beforeEach(async () => {
      // Port 1 on loopback: nothing listens there, so the connection is refused at once.
      const unreachable = { get: () => 'tcp://127.0.0.1:1' } as unknown as ConfigService<Env, true>;
      ({ app, ...session } = await start(new DockerService(unreachable)));
    });

    it('needs a session', async () => {
      const response = await fetch(`${session.origin}${containerLogsPath(POSTGRES)}`);
      expect(response.status).toBe(401);
    });

    it('answers as an event stream that ends with reason error', async () => {
      const reader = await open(POSTGRES);
      expect(reader.response.status).toBe(200);
      expect(reader.response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
      expect(reader.response.headers.get('cache-control')).toBe('no-store');
      await reader.ended;
      expect(reader.events).toEqual([{ event: 'end', reason: 'error' }]);
      expect(app.get(ContainerLogStreams).openCount).toBe(0);
    });

    it('refuses invalid requests with 400, before asking Docker', async () => {
      for (const [name, query, headers] of [
        ['a/b', '', {}],
        ['-flag', '', {}],
        ['.hidden', '', {}],
        [POSTGRES, '?tail=0', {}],
        [POSTGRES, '?tail=5001', {}],
        [POSTGRES, '?tail=1e3', {}],
        [POSTGRES, '?since=yesterday', {}],
        [POSTGRES, '?follow=0', {}],
        [POSTGRES, '', { 'Last-Event-ID': 'yesterday' }],
      ] as const) {
        const reader = await open(name, { query, headers });
        expect(reader.response.status, `${name}${query} ${JSON.stringify(headers)}`).toBe(400);
      }
      expect(app.get(ContainerLogStreams).openCount).toBe(0);
    });
  });

  describe.skipIf(!dockerReachable)('with real Docker', () => {
    beforeEach(async () => {
      ({ app, ...session } = await start());
    });

    it('sends the last lines of the dev Postgres, follows, and stops when the browser leaves', async () => {
      const reader = await open(POSTGRES, { query: '?tail=3' });
      await vi.waitFor(() => expect(reader.lines).toHaveLength(3));
      const streams = app.get(ContainerLogStreams);
      expect(streams.openCount).toBe(1); // still following
      reader.close();
      await vi.waitFor(() => expect(streams.openCount).toBe(0));
      expect(reader.events.some((e) => e.event === 'end')).toBe(false);
    });

    it('resumes after a Last-Event-ID (or since) without repeating it', async () => {
      const first = await open(POSTGRES, { query: '?tail=3' });
      await vi.waitFor(() => expect(first.lines).toHaveLength(3));
      const [, second, third] = first.lines;
      first.close();

      const resumed = await open(POSTGRES, {
        query: '?tail=3',
        headers: { 'Last-Event-ID': second.at },
      });
      await resumed.received(1);
      expect(resumed.lines[0]).toEqual(third);

      const bySince = await open(POSTGRES, { query: `?since=${encodeURIComponent(second.at)}` });
      await bySince.received(1);
      expect(bySince.lines[0]).toEqual(third);
    });

    it('ends with not_found for an unknown container', async () => {
      const reader = await open('laris-no-such-container');
      await reader.ended;
      expect(reader.events).toEqual([{ event: 'end', reason: 'not_found' }]);
    });
  });

  describe('limits', () => {
    beforeEach(async () => {
      // Every stream stays open (no output) until closed.
      const quiet = {
        // oxlint-disable-next-line require-yield -- a stream without output
        async *containerLogs(_name: string, _options: unknown, signal: AbortSignal) {
          await new Promise((resolve) => signal.addEventListener('abort', resolve));
          throw new DOMException('aborted', 'AbortError');
        },
      } as unknown as DockerService;
      ({ app, ...session } = await start(quiet));
    });

    it(`ends a ${LOG_LIMITS.maxStreamsPerSession + 1}th stream of a sign-in with too_many`, async () => {
      for (const name of ['a', 'b', 'c', 'd']) await open(name);
      const streams = app.get(ContainerLogStreams);
      await vi.waitFor(() => expect(streams.openCount).toBe(LOG_LIMITS.maxStreamsPerSession));
      const refused = await open('e');
      await refused.ended;
      expect(refused.events).toEqual([{ event: 'end', reason: 'too_many' }]);
    });

    it('ends the session’s streams at once on sign-out; reconnecting is refused', async () => {
      const a = await open('a');
      const b = await open('b');
      const streams = app.get(ContainerLogStreams);
      await vi.waitFor(() => expect(streams.openCount).toBe(2));
      await session.signOut();
      await Promise.all([a.ended, b.ended]);
      expect(streams.openCount).toBe(0);
      expect((await open('a')).response.status).toBe(401);
    });
  });
});
