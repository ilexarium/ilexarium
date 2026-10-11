import { PasswordHasher } from '@nestjs/authentication';
import type { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import type { Env } from '../src/config/env.schema.js';
import { ContainersService } from '../src/containers/containers.service.js';
import { DockerService } from '../src/docker/docker.service.js';
import { type Client, connectSignedIn, testHasher } from './realtime-client.js';

/** Port 1 on loopback: nothing listens there, so the connection is refused at once. */
const UNREACHABLE = 'tcp://127.0.0.1:1';

// The `containers` topic end to end with Docker unreachable: the page must get a clear
// "not reachable" state, never an error or silence. (With real Docker: step 5, through the proxy.)
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
