import { PasswordHasher } from '@nestjs/authentication';
import type { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import type { Env } from '../src/config/env.schema.js';
import { ContainersService } from '../src/containers/containers.service.js';
import { DockerService } from '../src/docker/docker.service.js';
import { proxyReachable } from './docker-proxy.js';
import { type Client, connectSignedIn, testHasher } from './realtime-client.js';

/** Port 1 on loopback: nothing listens there, so the connection is refused at once. */
const UNREACHABLE = 'tcp://127.0.0.1:1';

// The `containers` topic end to end with Docker unreachable: the page must get a clear
// "not reachable" state, never an error or silence.
describe('containers topic without Docker (e2e)', () => {
  let app: NestExpressApplication;
  let client: Client;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PasswordHasher)
      .useValue(testHasher)
      .overrideProvider(DockerService)
      .useValue(
        new DockerService({ get: () => UNREACHABLE } as unknown as ConfigService<Env, true>),
      )
      .compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    client = await connectSignedIn(app);
  });

  afterEach(async () => {
    client.socket.terminate();
    await app.close();
  });

  it('reports Docker as not reachable, then stops trying when unsubscribed', async () => {
    client.send({ event: 'subscribe', data: { topic: 'containers' } });
    const [snapshot] = await client.received(1);
    expect(snapshot).toEqual({ event: 'containers:snapshot', data: { dockerAvailable: false } });

    const [, update] = await client.received(2, 4000);
    expect(update).toEqual({ event: 'containers:update', data: { dockerAvailable: false } });

    client.send({ event: 'unsubscribe', data: { topic: 'containers' } });
    const containers = app.get(ContainersService);
    await vi.waitFor(() => expect(containers.collecting).toBe(false));
  });
});

const dockerReachable = await proxyReachable();

describe.skipIf(!dockerReachable)('containers topic with real Docker (e2e)', () => {
  let app: NestExpressApplication;
  let client: Client;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PasswordHasher)
      .useValue(testHasher)
      .compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    client = await connectSignedIn(app);
  });

  afterEach(async () => {
    client.socket.terminate();
    await app.close();
  });

  it('sends the containers, then updates with live stats, and closes every stream when unsubscribed', async () => {
    client.send({ event: 'subscribe', data: { topic: 'containers' } });
    const [snapshot] = await client.received(1);
    if (snapshot.event !== 'containers:snapshot' || !snapshot.data.dockerAvailable) {
      throw new Error(`Expected containers, got ${JSON.stringify(snapshot)}`);
    }
    const postgres = snapshot.data.containers.find((c) => c.name === 'laris-dev-postgres-1');
    expect(postgres).toMatchObject({ state: 'running', health: 'healthy' });

    // Stats frames arrive about once a second; the first update after that carries them.
    await client.received(3, 4000);
    const update = client.messages[2];
    if (update.event !== 'containers:update' || !update.data.dockerAvailable) {
      throw new Error(`Expected an update, got ${JSON.stringify(update)}`);
    }
    const live = update.data.containers.find((c) => c.name === 'laris-dev-postgres-1');
    expect(live!.stats!.memoryUsedBytes).toBeGreaterThan(0);

    const containers = app.get(ContainersService);
    expect(containers.openStreams).toBeGreaterThan(1); // stats streams + events
    client.send({ event: 'unsubscribe', data: { topic: 'containers' } });
    await vi.waitFor(() => expect(containers.collecting).toBe(false));
    expect(containers.openStreams).toBe(0);
  });
});
