import type { AddressInfo } from 'node:net';
import { PasswordHasher } from '@nestjs/authentication';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { DockerService } from '../src/docker/docker.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { UsersService } from '../src/users/users.service.js';
import { resetDatabase } from './database.js';
import { proxyReachable } from './docker-proxy.js';
import { testHasher } from './realtime-client.js';

// Container actions end to end: the app, the socket proxy and the real Docker daemon. Only the
// dev sandbox container (npm run db:up) is ever changed; the protected Postgres only refused.

const SANDBOX = 'homelab-dev-sandbox-1';
const POSTGRES = 'homelab-dev-postgres-1';
const PASSWORD = 'correct horse battery staple';

const reachable = await proxyReachable();

describe.skipIf(!reachable)('container actions (e2e, real Docker)', () => {
  let app: NestExpressApplication;
  let origin: string;
  let cookie: string;
  let docker: DockerService;

  const post = (path: string) =>
    request(origin).post(`/api/containers/${path}`).set('Origin', origin).set('Cookie', cookie);

  const auditEntries = () =>
    app.get(PrismaService).auditEvent.findMany({
      where: { action: { startsWith: 'container.' } },
      orderBy: { at: 'asc' },
      select: { action: true, outcome: true, username: true, details: true },
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PasswordHasher)
      .useValue(testHasher)
      .compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.listen(0, '127.0.0.1');
    origin = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    docker = app.get(DockerService);
  });

  beforeEach(async () => {
    await resetDatabase(app.get(PrismaService));
    await app.get(UsersService).create({
      username: 'owner',
      passwordHash: await testHasher.hash(PASSWORD),
    });
    const login = await request(origin)
      .post('/api/auth/login')
      .set('Origin', origin)
      .send({ username: 'owner', password: PASSWORD })
      .expect(200);
    cookie = ([] as string[])
      .concat(login.headers['set-cookie'] ?? [])
      .find((c) => c.startsWith('__Host-sid='))!
      .split(';')[0];
    expect(await docker.containerState(SANDBOX), `${SANDBOX} — run npm run db:up`).not.toBeNull();
  });

  afterAll(async () => {
    // Leave the sandbox running, whatever happened above.
    await post(`${SANDBOX}/start`).catch(() => undefined);
    await app.close();
  });

  it('stops, starts and restarts a container, recording each request and its outcome', async () => {
    await post(`${SANDBOX}/stop`).expect(204);
    expect(await docker.containerState(SANDBOX)).toBe('exited');
    await post(`${SANDBOX}/stop`).expect(204); // already stopped: still done

    await post(`${SANDBOX}/start`).expect(204);
    expect(await docker.containerState(SANDBOX)).toBe('running');

    await post(`${SANDBOX}/restart`).expect(204);
    expect(await docker.containerState(SANDBOX)).toBe('running');

    const details = { container: SANDBOX };
    expect(await auditEntries()).toEqual([
      { action: 'container.stop', outcome: 'requested', username: 'owner', details },
      { action: 'container.stop', outcome: 'success', username: 'owner', details },
      { action: 'container.stop', outcome: 'requested', username: 'owner', details },
      { action: 'container.stop', outcome: 'success', username: 'owner', details },
      { action: 'container.start', outcome: 'requested', username: 'owner', details },
      { action: 'container.start', outcome: 'success', username: 'owner', details },
      { action: 'container.restart', outcome: 'requested', username: 'owner', details },
      { action: 'container.restart', outcome: 'success', username: 'owner', details },
    ]);
  });

  it('refuses to stop or restart a protected container', async () => {
    for (const action of ['stop', 'restart']) {
      const res = await post(`${POSTGRES}/${action}`).expect(403);
      expect(res.body.code).toBe('container_protected');
    }
    expect(await docker.containerState(POSTGRES)).toBe('running');
    expect(await auditEntries()).toEqual([
      expect.objectContaining({ action: 'container.stop', outcome: 'failure' }),
      expect.objectContaining({ action: 'container.restart', outcome: 'failure' }),
    ]);
  });

  it('answers 404 with a code for an unknown container', async () => {
    for (const action of ['start', 'stop']) {
      const res = await post(`no-such-container-x7/${action}`).expect(404);
      expect(res.body.code).toBe('container_not_found');
    }
  });

  it('refuses other actions and names that are not names', async () => {
    for (const path of [
      `${SANDBOX}/kill`,
      `${SANDBOX}/pause`,
      `${SANDBOX}/remove`,
      `${SANDBOX}/STOP`,
      `.${SANDBOX}/stop`,
      `${encodeURIComponent('../json')}/stop`,
    ]) {
      await post(path).expect(400);
    }
    expect(await docker.containerState(SANDBOX)).toBe('running');
    expect(await auditEntries()).toEqual([]);
  });

  it('needs a session, and refuses other origins', async () => {
    await request(origin).post(`/api/containers/${SANDBOX}/stop`).set('Origin', origin).expect(401);
    await request(origin)
      .post(`/api/containers/${SANDBOX}/stop`)
      .set('Origin', 'https://evil.example')
      .set('Cookie', cookie)
      .expect(403);
    expect(await docker.containerState(SANDBOX)).toBe('running');
  });
});
