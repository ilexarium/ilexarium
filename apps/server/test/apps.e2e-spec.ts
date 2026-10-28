import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { PasswordHasher } from '@nestjs/authentication';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { AppDetails, AppFields, TemplateSummary } from '@laris/shared';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { UsersService } from '../src/users/users.service.js';
import { resetDatabase } from './database.js';
import { testHasher } from './realtime-client.js';

// Apps and templates end to end. What needs a Linux session runs against the development SSH
// server (dev/sshd: anna) — her files over SFTP; it has no Docker or systemd, so tasks themselves
// are the install test's (tools/vm/smoke.mjs).

const PASSWORD = 'correct horse battery staple';
const ANNA = { username: 'anna', password: 'anna-dev-password' };

const sshdUp = await new Promise<boolean>((done) => {
  const socket = connect(2222, '127.0.0.1');
  socket.once('connect', () => (socket.destroy(), done(true)));
  socket.once('error', () => done(false));
});

describe('apps and templates (e2e)', () => {
  let app: NestExpressApplication;
  let origin: string;
  let cookie: string;

  const api = () => ({
    get: (path: string) => request(origin).get(`/api${path}`).set('Cookie', cookie),
    post: (path: string, body: object = {}) =>
      request(origin).post(`/api${path}`).set('Origin', origin).set('Cookie', cookie).send(body),
    put: (path: string, body: object = {}) =>
      request(origin).put(`/api${path}`).set('Origin', origin).set('Cookie', cookie).send(body),
  });

  beforeAll(async () => {
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
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it('needs a session for everything', async () => {
    for (const path of ['/api/catalog', '/api/apps', '/api/apps/name?name=x', '/api/apps/x']) {
      await request(origin).get(path).expect(401);
    }
  });

  it('serves the templates, each with its compose.yml, and their icons only as harmless images', async () => {
    const list = (await api().get('/catalog').expect(200)).body as TemplateSummary[];
    expect(list.map((t) => t.id)).toEqual(['immich', 'navidrome', 'ollama']);
    const navidrome = (await api().get('/catalog/navidrome').expect(200)).body;
    expect(navidrome.compose).toContain('laris.template: navidrome@2');
    const icon = await api().get('/catalog/navidrome/icon').expect(200);
    expect(icon.headers['content-type']).toMatch(/^image\/svg\+xml/);
    expect(icon.headers['content-security-policy']).toContain('sandbox');
    await api().get('/catalog/nope').expect(404);
    await api().get('/catalog/Bad_Id').expect(400);
  });

  it('guesses a pasted file’s form; never checks values against the kinds', async () => {
    const fields = (
      await api()
        .post('/apps/fields', {
          compose:
            "services:\n  a:\n    image: x/y:${V:-1}\n    ports: ['${P}:80']\n    volumes: ['./d:/d', '${D}:/data']\n    environment:\n      ADMIN_PASSWORD: ${ADMIN_PASSWORD}\n",
          env: 'P=not-a-port\n',
          template: null,
        })
        .expect(200)
    ).body as AppFields;
    expect(fields.fields.map((f) => [f.key, f.kind, f.value])).toEqual([
      ['V', 'version', '1'],
      ['P', 'port', 'not-a-port'],
      ['D', 'folder', ''],
      ['ADMIN_PASSWORD', 'secret', ''],
    ]);
    await api().post('/apps/fields', { compose: 'x', env: '', template: '../x' }).expect(400);
  });

  it('checks a name against every Compose project, suggesting a free one', async () => {
    const free = (await api().get('/apps/name?name=fresh-app').expect(200)).body;
    expect(free).toEqual({ free: true, suggestion: 'fresh-app' });
    const bad = (await api().get('/apps/name?name=Not%20A%20Name').expect(200)).body;
    expect(bad.free).toBe(false);
    expect(bad.suggestion).toBe('not-a-name');
  });

  it('refuses a request that isn’t one, before anything happens', async () => {
    for (const body of [
      { name: 'Bad Name', folder: null, template: null, compose: 'services: {}', env: '' },
      { name: 'ok', folder: 'relative', template: null, compose: 'services: {}', env: '' },
      { name: 'ok', folder: null, template: null, compose: '', env: '' },
      { name: 'ok', folder: null, template: null, compose: 'services: {}', env: '', extra: 1 },
    ]) {
      await api().post('/apps', body).expect(400);
    }
    await api().get('/apps/versions?image=').expect(400);
    // Larger than any Compose file: refused before it's read.
    await api()
      .post('/apps', {
        name: 'ok',
        folder: null,
        template: null,
        compose: 'x'.repeat(300_000),
        env: '',
      })
      .expect((r) => expect([400, 413]).toContain(r.status));
  });

  it('reads and changes an app only as a Linux user (403, never 401)', async () => {
    const reading = await api().get('/apps/music').expect(403);
    expect(reading.body.code).toBe('linux_session_required');
    const installing = await api()
      .post('/apps', {
        name: 'music',
        folder: null,
        template: null,
        compose: 'services: {}',
        env: '',
      })
      .expect(403);
    expect(installing.body.code).toBe('linux_session_required');
  });

  it.skipIf(!sshdUp)(
    'as anna: an app folder of hers is read fresh; another’s is hers to read',
    async () => {
      await api().post('/files/session', ANNA).expect(200);
      const folder = `/home/anna/apps/e2e-${Date.now()}`;
      await api().post('/files/folder', { parent: '/home/anna', name: 'apps' });
      await api().post('/files/folder', {
        parent: '/home/anna/apps',
        name: folder.split('/').pop(),
      });
      const compose = "services:\n  web:\n    image: nginx:1.27\n    ports: ['${PORT:-8080}:80']\n";
      await request(origin)
        .put(`/api/files/upload?folder=${encodeURIComponent(folder)}&name=compose.yml`)
        .set('Origin', origin)
        .set('Cookie', cookie)
        .set('Content-Type', 'application/octet-stream')
        .send(compose)
        .expect(204);
      const name = folder.split('/').pop()!;
      const details = (
        await api()
          .get(`/apps/${name}?folder=${encodeURIComponent(folder)}`)
          .expect(200)
      ).body as AppDetails;
      expect(details).toMatchObject({ folder, compose, env: '', task: null, beforeUpdate: null });
      expect(details.fields.map((f) => [f.key, f.kind, f.value])).toEqual([
        ['PORT', 'port', '8080'],
      ]);
      expect(details.images).toEqual([
        { service: 'web', image: 'nginx', tag: '1.27', variable: null },
      ]);
      expect(details.app).toMatchObject({ name, state: 'none', owner: 'anna' });

      // Saved with a hash from before a change on disk: refused, nothing written.
      const changed = await api()
        .put(`/apps/${name}/files`, {
          folder,
          compose: 'services: {}\n',
          env: '',
          hash: 'old',
          overwrite: false,
        })
        .expect(409);
      expect(changed.body.code).toBe('changed_on_disk');

      const other = await api().get('/apps/x?folder=%2Froot%2Fapps%2Fx').expect(403);
      expect(other.body.code).toBe('permission_denied');
      await api().post('/files/session/sudo').expect(400);
    },
  );
});
