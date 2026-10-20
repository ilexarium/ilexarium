import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PasswordHasher } from '@nestjs/authentication';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { InstalledService, Job } from '@homelab/shared';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { DockerService } from '../src/docker/docker.service.js';
import { ExecutorService } from '../src/executor/executor.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { SecretsService } from '../src/secrets/secrets.service.js';
import { UsersService } from '../src/users/users.service.js';
import { resetDatabase } from './database.js';
import { proxyReachable } from './docker-proxy.js';
import { testHasher } from './realtime-client.js';

// Installing and removing a service end to end: the app, the executor in direct mode, the real
// wrapper (system/wrappers/homelab-compose.mts) and the real Docker daemon. The catalog is a copy
// of test/fixtures/catalog (busybox serving a folder); storage lives in a temporary folder.

const FIXTURES = fileURLToPath(new URL('./fixtures/catalog', import.meta.url));
const WRAPPER_CONFIG = resolve('.dev/wrappers.test.json');
const DOCKER = ['/usr/bin/docker', '/usr/local/bin/docker'].find((p) => existsSync(p));
const PASSWORD = 'correct horse battery staple';

const reachable = DOCKER !== undefined && (await proxyReachable());

describe.skipIf(!reachable)('services (e2e, real Docker)', () => {
  let app: NestExpressApplication;
  let origin: string;
  let cookie: string;
  let dir: string;
  let storage: string;
  let port: number;

  const api = () => ({
    get: (path: string) => request(origin).get(`/api${path}`).set('Cookie', cookie),
    post: (path: string, body: object) =>
      request(origin).post(`/api${path}`).set('Origin', origin).set('Cookie', cookie).send(body),
    delete: (path: string) =>
      request(origin).delete(`/api${path}`).set('Origin', origin).set('Cookie', cookie),
  });

  async function service(): Promise<InstalledService | undefined> {
    const res = await api().get('/services').expect(200);
    return (res.body.services as InstalledService[]).find((s) => s.catalogId === 'test-hello');
  }

  /** Waits until the service's latest job has finished; returns it. */
  async function settled(timeoutMs = 180_000): Promise<{ service?: InstalledService; job: Job }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await api().get('/catalog/test-hello').expect(200);
      if (!['installing', 'removing'].includes(res.body.status)) break;
      if (Date.now() > deadline) throw new Error('job did not finish');
      await new Promise((r) => setTimeout(r, 500));
    }
    const jobs = await app
      .get(PrismaService)
      .serviceJob.findMany({ orderBy: { startedAt: 'desc' }, take: 1 });
    const job = (await api().get(`/services/jobs/${jobs[0].id}`).expect(200)).body as Job;
    return { service: await service(), job };
  }

  const projectContainers = async () =>
    (await app.get(DockerService).listContainers()).filter(
      (c) => c.composeProject === 'hl-test-hello',
    );

  async function freePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port: free } = server.address() as AddressInfo;
    await new Promise((r) => server.close(r));
    return free;
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'services-e2e-'));
    storage = join(dir, 'srv');
    mkdirSync(storage, { mode: 0o755 });
    cpSync(FIXTURES, join(dir, 'catalog'), { recursive: true });
    mkdirSync(resolve('.dev'), { recursive: true });
    writeFileSync(
      WRAPPER_CONFIG,
      JSON.stringify({
        catalogDir: join(dir, 'catalog'),
        storageRoots: [storage],
        serviceRoot: storage,
        reservedPorts: [22, 3000],
        protectedPaths: [],
        dockerBin: DOCKER,
        lockFile: join(dir, 'compose.lock'),
        home: homedir(),
      }),
    );
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PasswordHasher)
      .useValue(testHasher)
      .compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.listen(0, '127.0.0.1');
    origin = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    await resetDatabase(app.get(PrismaService));
    await app
      .get(UsersService)
      .create({ username: 'owner', passwordHash: await testHasher.hash(PASSWORD) });
    const login = await request(origin)
      .post('/api/auth/login')
      .set('Origin', origin)
      .send({ username: 'owner', password: PASSWORD })
      .expect(200);
    cookie = ([] as string[])
      .concat(login.headers['set-cookie'] ?? [])
      .find((c) => c.startsWith('__Host-sid='))!
      .split(';')[0];
    port = await freePort();
  }, 60_000);

  afterAll(async () => {
    // Never leave the test service behind.
    await app
      ?.get(ExecutorService)
      .composeDown({
        catalogId: 'test-hello',
        serviceId: 'cleanup',
        secrets: [],
        fields: [],
        actor: {
          user: {
            id: '00000000-0000-0000-0000-000000000000',
            username: 'test',
            createdAt: '',
            displayName: null,
            email: null,
            language: null,
            avatar: null,
          },
        },
        audit: {},
        onPhase: () => undefined,
        onOutput: () => undefined,
      })
      .catch(() => undefined);
    await app?.close();
    rmSync(WRAPPER_CONFIG, { force: true }); // other e2e files get the defaults again
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it('lists the catalog and suggests values for this machine', async () => {
    const list = await api().get('/catalog').expect(200);
    expect(list.body).toEqual([
      {
        id: 'test-hello',
        name: 'Test Hello',
        category: 'tools',
        status: null,
        // The test recipe has no backup section.
        backupFolders: [],
        backupRestoreNote: false,
      },
    ]);
    const details = await api().get('/catalog/test-hello').expect(200);
    expect(details.body.suggested.SITE_DIR).toBe(join(storage, 'test-hello', 'site'));
    expect(details.body.images).toEqual([expect.stringMatching(/^busybox:1\.37@sha256:/)]);
    expect(details.body.keptSecrets).toEqual([]);
    const icon = await api().get('/catalog/test-hello/icon').expect(200);
    expect(icon.headers['content-type']).toMatch(/^image\/svg\+xml/);
    expect(icon.headers['content-security-policy']).toContain("default-src 'none'");
  });

  it('installs, serves, refuses a second install, removes keeping the data — and reinstalls with the same secret', async () => {
    const site = join(storage, 'test-hello', 'site');
    const deploy = await api()
      .post('/services', { catalogId: 'test-hello', values: { WEB_PORT: port, SITE_DIR: site } })
      .expect(202);
    expect(deploy.body).toEqual({ serviceId: expect.any(String), jobId: expect.any(String) });

    const installed = await settled();
    expect(installed.job, installed.job.output.join('\n')).toMatchObject({
      status: 'succeeded',
      phase: 'done',
    });
    expect(installed.service).toMatchObject({
      status: 'installed',
      webPort: port,
      settings: { WEB_PORT: port, SITE_DIR: site },
    });
    expect(installed.service!.settings).not.toHaveProperty('TOKEN');

    // The folder was created by the wrapper; what we put there is served on the chosen port.
    writeFileSync(join(site, 'index.html'), 'hello from the e2e test');
    const page = await fetch(`http://127.0.0.1:${port}/`);
    expect(await page.text()).toBe('hello from the e2e test');

    // The generated secret is stored encrypted and never appears in the output.
    const prisma = app.get(PrismaService);
    const stored = await prisma.serviceSecret.findMany({
      where: { serviceId: deploy.body.serviceId },
    });
    expect(stored.map((s) => s.key)).toEqual(['TOKEN']);
    const token = app
      .get(SecretsService)
      .decrypt(stored[0].value, `service:${deploy.body.serviceId}:TOKEN`);
    expect(token).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(Buffer.from(stored[0].value).includes(Buffer.from(token))).toBe(false);
    expect(installed.job.output.join('\n')).not.toContain(token);

    const audit = await prisma.auditEvent.findMany({
      where: { action: 'service.deploy' },
      orderBy: { at: 'asc' },
    });
    expect(audit.map((e) => e.outcome)).toEqual(['requested', 'success']);
    expect(JSON.stringify(audit)).not.toContain(token);

    const again = await api()
      .post('/services', {
        catalogId: 'test-hello',
        values: { WEB_PORT: port + 1, SITE_DIR: site },
      })
      .expect(409);
    expect(again.body.code).toBe('service_already_installed');

    await api().delete(`/services/${deploy.body.serviceId}`).expect(202);
    const removed = await settled();
    expect(removed.job).toMatchObject({ kind: 'remove', status: 'succeeded' });
    expect(removed.service).toBeUndefined(); // no longer listed as installed
    expect(await projectContainers()).toEqual([]);
    expect(existsSync(join(site, 'index.html'))).toBe(true); // data kept
    const catalog = await api().get('/catalog/test-hello').expect(200);
    expect(catalog.body).toMatchObject({
      status: 'removed',
      suggested: { WEB_PORT: port, SITE_DIR: site },
    });

    // Reinstall: the previous settings and the same generated secret.
    const reinstall = await api()
      .post('/services', { catalogId: 'test-hello', values: { WEB_PORT: port, SITE_DIR: site } })
      .expect(202);
    expect(reinstall.body.serviceId).toBe(deploy.body.serviceId);
    expect((await settled()).service?.status).toBe('installed');
    const restored = await prisma.serviceSecret.findMany({
      where: { serviceId: deploy.body.serviceId },
    });
    expect(
      app.get(SecretsService).decrypt(restored[0].value, `service:${deploy.body.serviceId}:TOKEN`),
    ).toBe(token);

    await api().delete(`/services/${deploy.body.serviceId}`).expect(202);
    expect((await settled()).job.status).toBe('succeeded');
  }, 300_000);

  it('answers with errors on the fields: a port in use, a folder outside the storage, a bad value', async () => {
    const server: Server = createServer();
    await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
    try {
      const inUse = await api()
        .post('/services', {
          catalogId: 'test-hello',
          values: { WEB_PORT: port, SITE_DIR: join(storage, 'test-hello', 'site') },
        })
        .expect(400);
      expect(inUse.body.errors).toEqual([
        { field: 'WEB_PORT', code: 'port_in_use', message: 'errors.port_in_use' },
      ]);
    } finally {
      server.close();
    }
    const outside = await api()
      .post('/services', { catalogId: 'test-hello', values: { WEB_PORT: port, SITE_DIR: '/etc' } })
      .expect(400);
    expect(outside.body.errors).toEqual([
      { field: 'SITE_DIR', code: 'path_not_allowed', message: 'errors.path_not_allowed' },
    ]);
    const bad = await api()
      .post('/services', {
        catalogId: 'test-hello',
        values: { WEB_PORT: 80, SITE_DIR: '/x', TOKEN: 'mine' },
      })
      .expect(400);
    expect(bad.body.errors.map((e: { field: string }) => e.field).sort()).toEqual(['', 'WEB_PORT']);
    await api().post('/services', { catalogId: 'nope', values: {} }).expect(404);
    expect(await projectContainers()).toEqual([]);
  });

  it('needs a session, and refuses other origins', async () => {
    await request(origin).get('/api/services').expect(401);
    await request(origin)
      .post('/api/services')
      .set('Origin', 'https://evil.example')
      .set('Cookie', cookie)
      .send({ catalogId: 'test-hello', values: {} })
      .expect(403);
  });

  it('is stopped by the wrapper itself when a recipe breaks the policy, even past the app’s checks', async () => {
    // Added after the app loaded the catalog, so only the wrapper sees it.
    const bad = join(dir, 'catalog', 'test-bad');
    cpSync(join(dir, 'catalog', 'test-hello'), bad, { recursive: true });
    writeFileSync(
      join(bad, 'meta.json'),
      JSON.stringify({
        ...JSON.parse('{}'),
        schemaVersion: 1,
        id: 'test-bad',
        version: '1',
        name: 'Bad',
        category: 'tools',
        website: 'https://example.org',
        webPort: 'WEB_PORT',
        dataOwner: { uid: 0, gid: 0 },
        fields: [{ key: 'WEB_PORT', type: 'port', default: 18081 }],
      }),
    );
    writeFileSync(
      join(bad, 'compose.yml'),
      `services:\n  web:\n    image: busybox:1.37@sha256:${'b'.repeat(64)}\n    privileged: true\n    ports: ['\${WEB_PORT}:8080']\n    restart: unless-stopped\n    logging: { driver: json-file, options: { max-size: 1m } }\n`,
    );
    const outcome = await app.get(ExecutorService).composeUp({
      catalogId: 'test-bad',
      serviceId: 'test',
      values: { WEB_PORT: port },
      secrets: [],
      fields: ['WEB_PORT'],
      actor: {
        user: {
          id: '00000000-0000-0000-0000-000000000000',
          username: 'test',
          createdAt: '',
          displayName: null,
          email: null,
          language: null,
          avatar: null,
        },
      },
      audit: {},
      onPhase: () => undefined,
      onOutput: () => undefined,
    });
    expect(outcome).toEqual({ ok: false, code: 'policy_violation', field: null });
    expect(
      (await app.get(DockerService).listContainers()).filter(
        (c) => c.composeProject === 'hl-test-bad',
      ),
    ).toEqual([]);
  });
});
