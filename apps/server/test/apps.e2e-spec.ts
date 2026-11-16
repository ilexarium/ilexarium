import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { PasswordHasher } from '@nestjs/authentication';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { AppDetails, AppFields, AppRemoval, FileList, TemplateSummary } from '@ilex/shared';
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
    expect(list.map((t) => t.id)).toEqual([
      'immich',
      'navidrome',
      'ollama',
      'open-webui',
      'pihole',
    ]);
    expect(list.find((t) => t.id === 'pihole')?.webPath).toBe('/admin/');
    expect(list.find((t) => t.id === 'navidrome')?.webPath).toBe('/');
    const navidrome = (await api().get('/catalog/navidrome').expect(200)).body;
    expect(navidrome.compose).toContain('ilex.template: navidrome@2');
    const icon = await api().get('/catalog/navidrome/icon').expect(200);
    expect(icon.headers['content-type']).toMatch(/^image\/svg\+xml/);
    expect(icon.headers['content-security-policy']).toContain('sandbox');
    await api().get('/catalog/nope').expect(404);
    await api().get('/catalog/Bad_Id').expect(400);
  });

  it('a template’s form from its template.json alone', async () => {
    const fields = (await api().post('/apps/fields', { template: 'immich' }).expect(200))
      .body as AppFields;
    expect(fields.fields.slice(0, 3).map((f) => [f.key, f.kind, f.value])).toEqual([
      ['WEB_PORT', 'port', '2283'],
      ['UPLOAD_DIR', 'folder', './library'],
      ['IMMICH_VERSION', 'version', 'v3'],
    ]);
    await api().post('/apps/fields', { template: '../x' }).expect(400);
    await api().post('/apps/fields', { template: 'nope' }).expect(404);
    // A pasted file has no form: its two files are edited as they are.
    await api().post('/apps/fields', { template: null, compose: 'x', env: '' }).expect(400);
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
    // Gone: versions from registries, changing an image tag, using the current template.
    await api().post('/apps/ok/image', { folder: '/home/anna/apps/ok' }).expect(404);
    await api().post('/apps/ok/template', { folder: '/home/anna/apps/ok' }).expect(404);
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
    const starting = await api()
      .post('/apps/music/start', { folder: '/home/anna/apps/music' })
      .expect(403);
    expect(starting.body.code).toBe('linux_session_required');
  });

  describe.skipIf(!sshdUp)(
    'as anna (the dev SSH server: Compose, no Docker daemon or systemd)',
    // Many SSH round trips, a Compose check each, and a real sudo unlock.
    { timeout: 30_000 },
    () => {
      const upload = (folder: string, name: string, content: string) =>
        request(origin)
          .put(
            `/api/files/upload?folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(name)}&replace=true`,
          )
          .set('Origin', origin)
          .set('Cookie', cookie)
          .set('Content-Type', 'application/octet-stream')
          .send(content)
          .expect(204);
      const folderOf = (name: string) => `/home/anna/apps/${name}`;
      const makeFolder = (parent: string, name: string) =>
        api().post('/files/folder', { parent, name });
      /** An app folder of hers, made through Files (as if made outside Ilexarium). */
      async function appFolder(name: string, compose: string, env = '') {
        await makeFolder('/home/anna', 'apps');
        await makeFolder('/home/anna/apps', name);
        await upload(folderOf(name), 'compose.yml', compose);
        if (env) await upload(folderOf(name), '.env', env);
        return folderOf(name);
      }
      const exists = async (path: string) =>
        (await api().get(`/files/summary?path=${encodeURIComponent(path)}`)).status === 200;
      /** Its `down` finished: what the helper and systemd would have left. */
      async function downFinished(name: string, folder: string) {
        await makeFolder(folder, '.ilex');
        await makeFolder(`${folder}/.ilex`, 'tasks');
        await upload(
          `${folder}/.ilex`,
          'task.json',
          JSON.stringify({
            unit: `ilex-app-${name}-down-20261030T120000`,
            system: false,
            action: 'down',
            log: '20261030T120000-down.log',
            startedAt: '2026-10-30T12:00:00.000Z',
          }),
        );
        await upload(
          `${folder}/.ilex/tasks`,
          '20261030T120000-down.log',
          'Removed\n@@ilex-result\nsuccess\nexited\n0\n',
        );
      }

      beforeAll(async () => {
        await api().post('/files/session', ANNA).expect(200);
      });

      it('a folder of hers is read fresh; a pasted file has no form; another’s is not hers to read', async () => {
        const name = `e2e-${Date.now()}`;
        const compose =
          "services:\n  web:\n    image: nginx:1.27\n    ports: ['${PORT:-8080}:80']\n";
        const folder = await appFolder(name, compose);
        const details = (
          await api()
            .get(`/apps/${name}?folder=${encodeURIComponent(folder)}`)
            .expect(200)
        ).body as AppDetails;
        expect(details).toMatchObject({ folder, compose, env: '', task: null, template: null });
        expect(details.fields).toEqual([]);
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
      });

      it('a template’s app that doesn’t run: its label as Compose reads it, its form from the template', async () => {
        const name = `e2e-label-${Date.now()}`;
        const immich = (await api().get('/catalog/immich').expect(200)).body.compose as string;
        const { fields } = (await api().post('/apps/fields', { template: 'immich' }).expect(200))
          .body as AppFields;
        const env = fields
          .map((f) => `${f.key}=${f.key === 'WEB_PORT' ? '9999' : f.value || 'x'}\n`)
          .join('');
        const folder = await appFolder(name, immich, env);
        const details = (
          await api()
            .get(`/apps/${name}?folder=${encodeURIComponent(folder)}`)
            .expect(200)
        ).body as AppDetails;
        expect(details.template).toEqual({ id: 'immich', version: '2' });
        expect(details.fields.find((f) => f.key === 'WEB_PORT')?.value).toBe('9999');
      });

      it('removal lists what Compose says it mounts; delete only after its down, only that', async () => {
        const name = `e2e-rm-${Date.now()}`;
        const compose = [
          'services:',
          '  web:',
          '    image: nginx:1.27',
          '    volumes:',
          '      - ./data:/data',
          '      - ${MEDIA:?set MEDIA}:/media',
          '      - /var/cache/nginx',
          '      - db:/db',
          '      - /etc/localtime:/etc/localtime:ro',
          '  extra:',
          '    image: redis:7',
          '    profiles: [extra]',
          '    volumes: [./extra:/data]',
          'volumes:',
          '  db:',
          '',
        ].join('\n');
        const folder = await appFolder(name, compose);
        // A required variable missing: what Compose said, not an empty list.
        const refused = await api()
          .get(`/apps/${name}/removal?folder=${encodeURIComponent(folder)}`)
          .expect(400);
        expect(refused.body).toMatchObject({ code: 'compose_invalid' });
        expect(refused.body.detail).toContain('set MEDIA');

        await upload(folder, '.env', 'MEDIA=/home/anna/media\n');
        const { items } = (
          await api()
            .get(`/apps/${name}/removal?folder=${encodeURIComponent(folder)}`)
            .expect(200)
        ).body as AppRemoval;
        expect(items.map((i) => [i.kind, i.path, i.outside])).toEqual([
          ['settings', folder, false],
          ['folder', `${folder}/data`, false],
          ['folder', `${folder}/extra`, false],
          ['folder', '/home/anna/media', true],
          ['volume', `${name}_db`, false],
        ]);

        const request = {
          folder,
          settings: true,
          folders: [`${folder}/data`, `${folder}/extra`],
          volumes: [],
        };
        const early = await api().post(`/apps/${name}/delete`, request).expect(409);
        expect(early.body.code).toBe('app_task_running');
        await downFinished(name, folder);
        await makeFolder(folder, 'data');
        await makeFolder(folder, 'extra');
        await api()
          .post(`/apps/${name}/delete`, { ...request, folders: [...request.folders, '/home/anna'] })
          .expect(204);
        // Every inside folder ticked (the profiled service's too) and the settings: nothing else
        // was in it, so the folder went too; never her home.
        expect(await exists(folder)).toBe(false);
        expect(await exists('/home/anna')).toBe(true);
      });

      it('delete with the settings ticked: a file Compose doesn’t list stays, and the folder with it', async () => {
        const name = `e2e-keep-${Date.now()}`;
        const folder = await appFolder(
          name,
          'services:\n  web:\n    build: .\n    volumes: [./data:/data]\n',
          'A=1\n',
        );
        await upload(folder, 'Dockerfile', 'FROM nginx:1.27\n');
        await downFinished(name, folder);
        await makeFolder(folder, 'data');
        await api()
          .post(`/apps/${name}/delete`, {
            folder,
            settings: true,
            folders: [`${folder}/data`],
            volumes: [],
          })
          .expect(204);
        const left = (
          await api()
            .get(`/files/list?path=${encodeURIComponent(folder)}`)
            .expect(200)
        ).body as FileList;
        expect(left.entries.map((e) => e.name)).toEqual(['Dockerfile']);
      });

      it('install and save: Compose checks the files first; a task that can’t start leaves nothing changed', async () => {
        // No systemd here: the task would run through her sudo (a system unit).
        const name = `e2e-in-${Date.now()}`;
        const body = {
          name,
          folder: null,
          template: null,
          compose: "services:\n  web:\n    image: nginx:1.27\n    volumes: ['./data:/data']\n",
          env: '',
        };
        const locked = await api().post('/apps', body).expect(403);
        expect(locked.body.code).toBe('sudo_required');
        await api().post('/files/session/sudo', { password: ANNA.password }).expect(200);

        const invalid = await api()
          .post('/apps', { ...body, compose: 'services:\n  web:\n    bad: 1\n' })
          .expect(400);
        expect(invalid.body.code).toBe('compose_invalid');
        expect(await exists(folderOf(name))).toBe(false);

        const notStarted = await api().post('/apps', body).expect(502);
        expect(notStarted.body.code).toBe('app_task_not_started');
        expect(await exists(folderOf(name))).toBe(false);

        const compose = 'services:\n  web:\n    image: nginx:1.27\n';
        const folder = await appFolder(name, compose);
        const { hash } = (
          await api()
            .get(`/apps/${name}?folder=${encodeURIComponent(folder)}`)
            .expect(200)
        ).body as AppDetails;
        await api()
          .put(`/apps/${name}/files`, {
            folder,
            compose: "services:\n  web:\n    image: nginx:1.28\n    volumes: ['./data:/data']\n",
            env: 'A=1\n',
            hash,
            overwrite: false,
          })
          .expect(502);
        const after = (
          await api()
            .get(`/apps/${name}?folder=${encodeURIComponent(folder)}`)
            .expect(200)
        ).body as AppDetails;
        expect(after).toMatchObject({ compose, env: '', hash });
        await request(origin)
          .delete('/api/files/session/sudo')
          .set('Origin', origin)
          .set('Cookie', cookie)
          .expect(200);
      });
    },
  );
});
