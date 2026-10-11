import { PasswordHasher } from '@nestjs/authentication';
import type { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { WS_CLOSE_CODES } from '@homelab/shared';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import type { Env } from '../src/config/env.schema.js';
import { ContainerLogStreams } from '../src/container-logs/container-log-streams.js';
import { DockerService } from '../src/docker/docker.service.js';
import { proxyReachable } from './docker-proxy.js';
import { type Client, connectSignedIn, testHasher } from './realtime-client.js';

const POSTGRES = 'homelab-dev-postgres-1';

async function start(
  docker?: DockerService,
): Promise<{ app: NestExpressApplication; client: Client }> {
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PasswordHasher)
    .useValue(testHasher);
  if (docker) builder = builder.overrideProvider(DockerService).useValue(docker);
  const app = configureApp(
    (await builder.compile()).createNestApplication<NestExpressApplication>(),
  );
  return { app, client: await connectSignedIn(app) };
}

describe('container logs without Docker (e2e)', () => {
  let app: NestExpressApplication;
  let client: Client;

  beforeEach(async () => {
    // Port 1 on loopback: nothing listens there, so the connection is refused at once.
    const unreachable = { get: () => 'tcp://127.0.0.1:1' } as unknown as ConfigService<Env, true>;
    ({ app, client } = await start(new DockerService(unreachable)));
  });

  afterEach(async () => {
    client.socket.terminate();
    await app.close();
  });

  it('ends with reason error', async () => {
    client.send({ event: 'logs:open', data: { container: POSTGRES } });
    expect(await client.received(1)).toEqual([
      { event: 'logs:end', data: { container: POSTGRES, reason: 'error' } },
    ]);
    expect(app.get(ContainerLogStreams).openCount).toBe(0);
  });
});

const dockerReachable = await proxyReachable();

describe.skipIf(!dockerReachable)('container logs with real Docker (e2e)', () => {
  let app: NestExpressApplication;
  let client: Client;

  beforeEach(async () => {
    ({ app, client } = await start());
  });

  afterEach(async () => {
    client.socket.terminate();
    await app.close();
  });

  it('sends the last lines of the dev Postgres, follows, and closes the stream on logs:close', async () => {
    client.send({ event: 'logs:open', data: { container: POSTGRES, tail: 3 } });
    const [batch] = await client.received(1);
    if (batch.event !== 'logs:lines') throw new Error(`Expected lines, got ${batch.event}`);
    expect(batch.data.container).toBe(POSTGRES);
    expect(batch.data.lines).toHaveLength(3);

    const streams = app.get(ContainerLogStreams);
    expect(streams.openCount).toBe(1); // still following
    client.send({ event: 'logs:close', data: { container: POSTGRES } });
    await vi.waitFor(() => expect(streams.openCount).toBe(0));
    await client.flush();
    expect(client.events).toEqual(['logs:lines']); // no logs:end for a closed view
  });

  it('resumes after a given line without repeating it', async () => {
    client.send({ event: 'logs:open', data: { container: POSTGRES, tail: 3 } });
    const [first] = await client.received(1);
    if (first.event !== 'logs:lines') throw new Error(`Expected lines, got ${first.event}`);
    const [, second, third] = first.data.lines;

    client.send({ event: 'logs:open', data: { container: POSTGRES, tail: 3, since: second.at } });
    const [, resumed] = await client.received(2);
    if (resumed.event !== 'logs:lines') throw new Error(`Expected lines, got ${resumed.event}`);
    expect(resumed.data.lines[0]).toEqual(third);
    expect(app.get(ContainerLogStreams).openCount).toBe(1); // replaced, not added
  });

  it('closes the streams of a socket that disconnects', async () => {
    client.send({ event: 'logs:open', data: { container: POSTGRES, tail: 1 } });
    await client.received(1);
    const streams = app.get(ContainerLogStreams);
    expect(streams.openCount).toBe(1);
    client.socket.close();
    await vi.waitFor(() => expect(streams.openCount).toBe(0));
  });

  it('ends with not_found for an unknown container', async () => {
    client.send({ event: 'logs:open', data: { container: 'homelab-no-such-container' } });
    expect(await client.received(1)).toEqual([
      {
        event: 'logs:end',
        data: { container: 'homelab-no-such-container', reason: 'not_found' },
      },
    ]);
  });

  it('refuses invalid requests with invalid_message, before asking Docker', async () => {
    for (const data of [
      { container: '../json' },
      { container: 'a/b' },
      { container: POSTGRES, tail: 0 },
      { container: POSTGRES, tail: 5001 },
      { container: POSTGRES, since: 'yesterday' },
      { container: POSTGRES, follow: false },
    ]) {
      client.send({ event: 'logs:open', data });
    }
    client.send({ event: 'logs:close', data: { container: '..' } });
    const messages = await client.received(7);
    expect(messages.map((m) => (m.event === 'error' ? m.data.code : m.event))).toEqual(
      Array(7).fill('invalid_message'),
    );
    expect(app.get(ContainerLogStreams).openCount).toBe(0);
  });
});

describe('container log limits (e2e)', () => {
  let app: NestExpressApplication;
  let client: Client;

  beforeEach(async () => {
    // Every stream stays open (no output) until closed.
    const quiet = {
      // oxlint-disable-next-line require-yield -- a stream without output
      async *containerLogs(_name: string, _options: unknown, signal: AbortSignal) {
        await new Promise((resolve) => signal.addEventListener('abort', resolve));
      },
    } as unknown as DockerService;
    ({ app, client } = await start(quiet));
  });

  afterEach(async () => {
    client.socket.terminate();
    await app.close();
  });

  it('closes the session’s log streams at once on sign-out', async () => {
    client.send({ event: 'logs:open', data: { container: 'a' } });
    client.send({ event: 'logs:open', data: { container: 'b' } });
    await client.flush();
    const streams = app.get(ContainerLogStreams);
    expect(streams.openCount).toBe(2);
    await client.signOut();
    expect((await client.closed).code).toBe(WS_CLOSE_CODES.sessionEnded);
    await vi.waitFor(() => expect(streams.openCount).toBe(0));
  });

  it('refuses a 4th open stream with too_many_streams; closing one makes room', async () => {
    for (const container of ['a', 'b', 'c', 'd']) {
      client.send({ event: 'logs:open', data: { container } });
    }
    expect(await client.received(1)).toEqual([
      { event: 'error', data: { code: 'too_many_streams', message: expect.any(String) } },
    ]);
    const streams = app.get(ContainerLogStreams);
    expect(streams.openCount).toBe(3);

    client.send({ event: 'logs:close', data: { container: 'a' } });
    client.send({ event: 'logs:open', data: { container: 'd' } });
    await client.flush();
    expect(client.messages).toHaveLength(1); // no second error
    expect(streams.openCount).toBe(3);
  });
});
