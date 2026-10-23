import type { AddressInfo } from 'node:net';
import { AuthenticationEvents, PasswordHasher } from '@nestjs/authentication';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  REALTIME_PATH,
  type SystemSnapshot,
  type SystemUpdate,
  WS_CLOSE_CODES,
} from '@laris/shared';
import request from 'supertest';
import { WebSocket } from 'ws';
import { Client } from './realtime-client.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RealtimeConnections } from '../src/realtime/realtime-connections.js';
import { RealtimeSubscriptions } from '../src/realtime/realtime-subscriptions.js';
import {
  DEFAULT_REALTIME_OPTIONS,
  MAX_MESSAGE_BYTES,
  REALTIME_OPTIONS,
} from '../src/realtime/realtime.constants.js';
import { SystemMetricsService } from '../src/system-metrics/system-metrics.service.js';
import { UsersService } from '../src/users/users.service.js';
import { resetDatabase } from './database.js';
import type { RealtimeOptions, TopicSource } from '../src/realtime/realtime.model.js';
import { Observable } from 'rxjs';

const PASSWORD = 'correct horse battery';
const testHasher = new PasswordHasher({ logN: 11 });
/** Small limits so the tests reach them quickly. */
const OPTIONS: RealtimeOptions = {
  ...DEFAULT_REALTIME_OPTIONS,
  maxConnectionsPerSession: 2,
  messageLimit: 5,
  sessionRecheckMs: 300,
};
const POLICY_VIOLATION = 1008;
const MESSAGE_TOO_BIG = 1009;

const update: SystemUpdate = {
  uptimeSeconds: 2,
  sample: {
    at: 1_791_720_000_000,
    cpu: { usagePercent: 5, loadAverage: [0.1, 0.1, 0.1] },
    memory: {
      totalBytes: 8e9,
      usedBytes: 2e9,
      availableBytes: 6e9,
      swapTotalBytes: 0,
      swapUsedBytes: 0,
    },
    network: [],
  },
  disks: [],
};
const snapshot: SystemSnapshot = {
  ...update,
  host: {
    hostname: 'laris',
    os: 'Debian GNU/Linux 13',
    kernel: '6.12.0',
    arch: 'arm64',
    cpuModel: 'Cortex-A76',
    cpuCores: 4,
  },
  history: [],
};

/** Stands in for `SystemMetricsService`: lets tests publish, and records whether it is collecting. */
class FakeSystemSource implements TopicSource<'system'> {
  readonly topic = 'system';
  publish: ((update: SystemUpdate) => void) | null = null;
  starts = 0;
  async snapshot(): Promise<SystemSnapshot> {
    return snapshot;
  }
  readonly updates$ = new Observable<SystemUpdate>((subscriber) => {
    this.starts++;
    this.publish = (update) => subscriber.next(update);
    return () => (this.publish = null);
  });
}

describe('realtime WebSocket (e2e)', () => {
  let app: NestExpressApplication;
  let source: FakeSystemSource;
  let host: string;
  let cookie: string;
  const clients: Client[] = [];

  async function login(): Promise<string> {
    const res = await request(`http://${host}`)
      .post('/api/auth/login')
      .set('Origin', `http://${host}`)
      .send({ username: 'owner', password: PASSWORD })
      .expect(200);
    const setCookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    return setCookie.find((c) => c.startsWith('__Host-sid='))!.split(';')[0];
  }

  /** Opens a socket like a browser on this app's page would, unless told otherwise. */
  function connect({
    origin = `http://${host}`,
    withCookie = cookie,
  }: { origin?: string | null; withCookie?: string | null } = {}): Client {
    const headers: Record<string, string> = {};
    if (withCookie) headers.Cookie = withCookie;
    const socket = new WebSocket(`ws://${host}${REALTIME_PATH}`, {
      headers,
      ...(origin !== null && { origin }),
    });
    const client = new Client(socket);
    clients.push(client);
    return client;
  }

  async function connected(client: Client): Promise<Client> {
    if (client.socket.readyState !== WebSocket.OPEN) {
      await new Promise((resolve) => client.socket.once('open', resolve));
    }
    // Admission finishes after `open`; a round trip proves this socket was admitted.
    await client.flush();
    return client;
  }

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PasswordHasher)
      .useValue(testHasher)
      .overrideProvider(REALTIME_OPTIONS)
      .useValue(OPTIONS)
      // The fake stands in for the real system topic source, registering itself as it does.
      .overrideProvider(SystemMetricsService)
      .useFactory({
        factory: (subscriptions: RealtimeSubscriptions) => {
          const fake = new FakeSystemSource();
          subscriptions.registerSource(fake);
          return fake;
        },
        inject: [RealtimeSubscriptions],
      })
      .compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.listen(0, '127.0.0.1');
    host = `127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    source = app.get<FakeSystemSource>(SystemMetricsService);
    await resetDatabase(app.get(PrismaService));
    await app.get(UsersService).create({
      username: 'owner',
      passwordHash: await testHasher.hash(PASSWORD),
    });
    cookie = await login();
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.socket.terminate();
    await app.close();
  });

  describe('connecting', () => {
    it('closes a socket without a session with 4401, sending nothing', async () => {
      const client = connect({ withCookie: null });
      client.socket.on('open', () =>
        client.send({ event: 'subscribe', data: { topic: 'system' } }),
      );
      expect((await client.closed).code).toBe(WS_CLOSE_CODES.sessionEnded);
      expect(client.messages).toEqual([]);
      expect(source.starts).toBe(0);
    });

    it('closes a socket with an unknown session cookie with 4401', async () => {
      const client = connect({ withCookie: '__Host-sid=not-a-real-session-token' });
      expect((await client.closed).code).toBe(WS_CLOSE_CODES.sessionEnded);
    });

    it('closes a cross-site socket with 1008 — even one that subscribes the moment it opens', async () => {
      const client = connect({ origin: 'https://evil.example' });
      client.socket.on('open', () =>
        client.send({ event: 'subscribe', data: { topic: 'system' } }),
      );
      expect((await client.closed).code).toBe(POLICY_VIOLATION);
      expect(client.messages).toEqual([]);
      expect(source.starts).toBe(0);
    });

    it('closes a socket without an Origin with 1008', async () => {
      const client = connect({ origin: null });
      expect((await client.closed).code).toBe(POLICY_VIOLATION);
    });

    it('limits the open sockets per session', async () => {
      await connected(connect());
      await connected(connect());
      expect((await connect().closed).code).toBe(POLICY_VIOLATION);
    });

    it('frees a session slot when a socket closes', async () => {
      const first = await connected(connect());
      await connected(connect());
      first.socket.close();
      await first.closed;
      await connected(connect()); // would time out if refused
    });

    it('answers nothing on other paths', async () => {
      const socket = new WebSocket(`ws://${host}/api/other`, {
        headers: { Cookie: cookie },
        origin: `http://${host}`,
      });
      await expect(
        new Promise((resolve, reject) => {
          socket.on('open', resolve);
          socket.on('error', reject);
        }),
      ).rejects.toThrow();
    });
  });

  describe('subscriptions', () => {
    it('collects nothing until someone subscribes', async () => {
      await connected(connect());
      expect(source.starts).toBe(0);
    });

    it('sends the snapshot, then updates', async () => {
      const client = await connected(connect());
      client.send({ event: 'subscribe', data: { topic: 'system' } });
      await client.received(1);
      source.publish!(update);
      expect(await client.received(2)).toEqual([
        { event: 'system:snapshot', data: snapshot },
        { event: 'system:update', data: update },
      ]);
    });

    it('stops collecting on unsubscribe and when the last subscriber disconnects', async () => {
      const [a, b] = [await connected(connect()), await connected(connect())];
      for (const client of [a, b]) {
        client.send({ event: 'subscribe', data: { topic: 'system' } });
        await client.received(1);
      }
      a.send({ event: 'unsubscribe', data: { topic: 'system' } });
      await a.flush();
      source.publish!(update);
      await b.received(2);
      expect(a.events).toEqual(['system:snapshot']);

      b.socket.close();
      await b.closed;
      await vi.waitFor(() => expect(source.publish).toBeNull());
      expect(source.starts).toBe(1);
    });
  });

  describe('invalid messages', () => {
    it('answers a known event with invalid data with invalid_message', async () => {
      const client = await connected(connect());
      for (const data of [{ topic: 'logs' }, { topic: 'system', extra: 1 }, 'system', null]) {
        client.send({ event: 'subscribe', data });
      }
      const messages = await client.received(4);
      expect(messages.map((m) => m.event === 'error' && m.data.code)).toEqual(
        Array(4).fill('invalid_message'),
      );
      expect(source.starts).toBe(0);
    });

    it('drops malformed JSON and unknown events silently, keeping the connection', async () => {
      const client = await connected(connect());
      client.send('{not json');
      client.send({ event: 'publish', data: { topic: 'system' } });
      client.send({ type: 'subscribe', topic: 'system' });
      await client.flush();
      expect(client.messages).toEqual([]);
      expect(client.socket.readyState).toBe(WebSocket.OPEN);
    });

    it(`closes with 1009 on a message over ${MAX_MESSAGE_BYTES} bytes`, async () => {
      const client = await connected(connect());
      client.send({ event: 'subscribe', data: { topic: 'x'.repeat(MAX_MESSAGE_BYTES) } });
      expect((await client.closed).code).toBe(MESSAGE_TOO_BIG);
    });
  });

  describe('rate limit', () => {
    it('answers rate_limited past the limit, then closes with 1008 at twice the limit', async () => {
      const client = await connected(connect()); // the round trip in connected() counted once
      for (let i = 1; i < OPTIONS.messageLimit; i++) {
        client.send({ event: 'unsubscribe', data: { topic: 'system' } });
      }
      client.send({ event: 'unsubscribe', data: { topic: 'system' } });
      const [limited] = await client.received(1);
      expect(limited).toEqual({
        event: 'error',
        data: { code: 'rate_limited', message: expect.any(String) },
      });
      for (let i = 0; i < OPTIONS.messageLimit; i++) {
        client.send({ event: 'unsubscribe', data: { topic: 'system' } });
      }
      expect((await client.closed).code).toBe(POLICY_VIOLATION);
    });
  });

  describe('session ending', () => {
    async function signOut(): Promise<void> {
      await request(`http://${host}`)
        .post('/api/auth/logout')
        .set('Origin', `http://${host}`)
        .set('Cookie', cookie)
        .expect(204);
    }

    /** Re-checks far apart, so a close can only come from the sign-out itself. */
    async function withoutRecheck<T>(run: () => Promise<T>): Promise<T> {
      const connections = app.get(RealtimeConnections) as unknown as {
        recheck(): Promise<void>;
      };
      const recheck = vi.spyOn(connections, 'recheck').mockResolvedValue();
      // A re-check already under way finishes before the test starts.
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        return await run();
      } finally {
        recheck.mockRestore();
      }
    }

    it('closes every socket of the session at once on sign-out, and only those', async () => {
      await withoutRecheck(async () => {
        const [a, b] = [await connected(connect()), await connected(connect())];
        const otherSession = await connected(connect({ withCookie: await login() }));
        const before = Date.now();
        await signOut();
        expect((await a.closed).code).toBe(WS_CLOSE_CODES.sessionEnded);
        expect((await b.closed).code).toBe(WS_CLOSE_CODES.sessionEnded);
        expect(Date.now() - before).toBeLessThan(1000);
        await otherSession.flush(); // still open and served
      });
    });

    it('closes every socket of the user on a sign-out everywhere', async () => {
      await withoutRecheck(async () => {
        const [a, b] = [
          await connected(connect()),
          await connected(connect({ withCookie: await login() })),
        ];
        const owner = await app.get(UsersService).findByUsername('owner');
        app
          .get(AuthenticationEvents)
          .emit({ type: 'sign-out', userId: owner!.id, everywhere: true });
        expect((await a.closed).code).toBe(WS_CLOSE_CODES.sessionEnded);
        expect((await b.closed).code).toBe(WS_CLOSE_CODES.sessionEnded);
      });
    });

    it('ignores a sign-out of another user’s or a token family', async () => {
      await withoutRecheck(async () => {
        const client = await connected(connect());
        const events = app.get(AuthenticationEvents);
        events.emit({ type: 'sign-out', userId: 'someone-else', everywhere: true });
        events.emit({ type: 'sign-out', userId: 'someone-else', tokenFamilyId: 'family' });
        await new Promise((resolve) => setTimeout(resolve, 50)); // events arrive on the next tick
        await client.flush();
        expect(client.socket.readyState).toBe(WebSocket.OPEN);
      });
    });

    it('closes with 4401 on the next message after the session ends', async () => {
      const client = await connected(connect());
      await signOut();
      client.send({ event: 'subscribe', data: { topic: 'system' } });
      expect((await client.closed).code).toBe(WS_CLOSE_CODES.sessionEnded);
      expect(client.messages).toEqual([]);
      expect(source.starts).toBe(0);
    });

    it('closes with 4401 at the periodic re-check, without any message', async () => {
      const client = await connected(connect());
      client.send({ event: 'subscribe', data: { topic: 'system' } });
      await client.received(1);
      await signOut();
      expect((await client.closed).code).toBe(WS_CLOSE_CODES.sessionEnded);
      await vi.waitFor(() => expect(source.publish).toBeNull());
    });
  });
});
