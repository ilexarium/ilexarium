import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PasswordHasher } from '@nestjs/authentication';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { BackupItem, BackupPlan, BackupRestore, BackupRun } from '@homelab/shared';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { UsersService } from '../src/users/users.service.js';
import { resetDatabase } from './database.js';
import { testHasher } from './realtime-client.js';

// Backups end to end: the app, the executor in direct mode, the real backup wrapper
// (system/wrappers/homelab-backup.mts) and the real Borg — with a fake `docker` (the platform's
// dump, a service stopped and started) and a pretend disk (a folder listed in a mount table).

const FIXTURES = fileURLToPath(new URL('./fixtures/catalog', import.meta.url));
const FAKE_DOCKER = fileURLToPath(
  new URL('../../../system/wrappers/testing/fake-docker.cjs', import.meta.url),
);
const WRAPPER_CONFIG = resolve('.dev/wrappers.test.json');
const BORG = ['/usr/bin/borg', '/usr/local/bin/borg'].find((p) => existsSync(p));
const PASSWORD = 'correct horse battery staple';

describe.skipIf(!BORG)('backups (e2e, real Borg)', () => {
  let app: NestExpressApplication;
  let origin: string;
  let cookie: string;
  let dir: string;
  let storage: string;
  let disk: string;
  let serviceId: string;

  const api = () => ({
    get: (path: string) => request(origin).get(`/api${path}`).set('Cookie', cookie),
    post: (path: string, body: object) =>
      request(origin).post(`/api${path}`).set('Origin', origin).set('Cookie', cookie).send(body),
    put: (path: string, body: object) =>
      request(origin).put(`/api${path}`).set('Origin', origin).set('Cookie', cookie).send(body),
    delete: (path: string) =>
      request(origin).delete(`/api${path}`).set('Origin', origin).set('Cookie', cookie),
  });

  async function until<T>(read: () => Promise<T | undefined>, timeoutMs = 60_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await read();
      if (value !== undefined) return value;
      if (Date.now() > deadline) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  const finishedRun = (runId: string) =>
    until(async () => {
      const runs = (await api().get('/backups/runs').expect(200)).body.runs as BackupRun[];
      const run = runs.find((r) => r.id === runId);
      return run && run.status !== 'running' ? run : undefined;
    });

  const finishedRestore = (id: string) =>
    until(async () => {
      const restore = (await api().get(`/backups/restores/${id}`).expect(200))
        .body as BackupRestore;
      return restore.job.status !== 'running' ? restore : undefined;
    });

  const plan = async () => (await api().get('/backups/plan').expect(200)).body.plan as BackupPlan;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'backups-e2e-'));
    chmodSync(dir, 0o755);
    storage = join(dir, 'srv');
    disk = join(dir, 'mnt', 'usb');
    mkdirSync(join(storage, 'test-hello', 'site'), { recursive: true, mode: 0o755 });
    mkdirSync(join(storage, 'docs'), { recursive: true });
    mkdirSync(disk, { recursive: true });
    writeFileSync(join(storage, 'test-hello', 'site', 'index.html'), 'version 1');
    writeFileSync(join(storage, 'docs', 'letter.txt'), 'Dear …');
    writeFileSync(join(dir, 'mountinfo'), `100 30 8:17 / ${disk} rw - ext4 /dev/sdb1 rw\n`);
    // The test recipe, with a backup section.
    cpSync(FIXTURES, join(dir, 'catalog'), { recursive: true });
    const metaFile = join(dir, 'catalog', 'test-hello', 'meta.json');
    const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
    meta.backup = { folders: [{ field: 'SITE_DIR' }], mode: 'stop' };
    writeFileSync(metaFile, JSON.stringify(meta));
    writeFileSync(
      join(dir, 'docker'),
      `#!${process.execPath}\n${readFileSync(FAKE_DOCKER, 'utf8')}`,
      {
        mode: 0o755,
      },
    );
    writeFileSync(join(dir, 'running.txt'), 'hl-test-hello');
    mkdirSync(resolve('.dev'), { recursive: true });
    writeFileSync(
      WRAPPER_CONFIG,
      JSON.stringify({
        catalogDir: join(dir, 'catalog'),
        storageRoots: [storage],
        serviceRoot: storage,
        reservedPorts: [22, 3000],
        protectedPaths: [],
        dockerBin: join(dir, 'docker'),
        lockFile: join(dir, 'compose.lock'),
        home: homedir(),
        backup: {
          borgBin: BORG,
          platform: {
            container: 'homelab-postgres-1',
            database: 'homelab',
            user: 'homelab',
            files: [WRAPPER_CONFIG],
          },
          dev: {
            dir: join(dir, 'backup'),
            destinationRoots: [join(dir, 'mnt')],
            mountInfo: join(dir, 'mountinfo'),
            retryDelayMs: 10,
          },
        },
      }),
    );
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PasswordHasher)
      .useValue(testHasher)
      .compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.listen(0, '127.0.0.1');
    origin = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    const prisma = app.get(PrismaService);
    await resetDatabase(prisma);
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
    serviceId = (
      await prisma.service.create({
        data: {
          catalogId: 'test-hello',
          catalogVersion: '1',
          status: 'installed',
          settings: { WEB_PORT: 18080, SITE_DIR: join(storage, 'test-hello', 'site') },
        },
      })
    ).id;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    rmSync(WRAPPER_CONFIG, { force: true }); // other e2e files get the defaults again
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts without a plan, and lists the mounted disk', async () => {
    expect((await api().get('/backups/plan').expect(200)).body).toEqual({ plan: null });
    expect((await api().get('/backups/status').expect(200)).body).toMatchObject({
      configured: false,
      warnings: [],
    });
    const { destinations } = (await api().get('/backups/destinations').expect(200)).body;
    expect(destinations).toEqual([
      expect.objectContaining({
        mountPoint: disk,
        filesystem: 'ext4',
        supported: true,
        hasRepository: false,
      }),
    ]);
  });

  it('refuses a disk that is not mounted, and folders outside the allowed places', async () => {
    const setup = {
      destination: join(dir, 'mnt', 'other'),
      schedule: { frequency: 'daily', time: '03:00' },
      retention: { daily: 7, weekly: 4, monthly: 6 },
      items: [],
    };
    const res = await api().post('/backups/plan', setup).expect(400);
    expect(res.body.errors[0]).toMatchObject({
      field: 'destination',
      code: 'destination_not_allowed',
    });
    const bad = await api()
      .post('/backups/plan', {
        ...setup,
        destination: disk,
        items: [{ kind: 'folder', path: '/etc' }],
      })
      .expect(400);
    expect(bad.body.errors[0]).toMatchObject({ field: 'items.0', code: 'path_not_allowed' });
    expect((await api().get('/backups/plan').expect(200)).body).toEqual({ plan: null });
  });

  it('sets up: the repository, the plan, and the passphrase shown once', async () => {
    const res = await api().post('/backups/plan', {
      destination: disk,
      schedule: { frequency: 'daily', time: '03:00' },
      retention: { daily: 7, weekly: 4, monthly: 6 },
      items: [
        { kind: 'service', serviceId },
        { kind: 'folder', path: join(storage, 'docs') },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.passphrase.split(' ')).toHaveLength(6);
    expect(existsSync(join(disk, 'homelab-backups', 'config'))).toBe(true);
    const current = await plan();
    expect(current.items.map((i) => i.kind)).toEqual(['platform', 'service', 'folder']);
    expect(current.destinationStatus).toMatchObject({ mountPoint: disk, hasRepository: true });
    await api()
      .post('/backups/plan', { ...res.body, destination: disk })
      .expect(400);
  }, 60_000);

  it('backs up now: each item gets an archive, the history and the status show it', async () => {
    const { runId } = (await api().post('/backups/runs', {}).expect(202)).body;
    const run = await finishedRun(runId);
    expect(run).toMatchObject({ trigger: 'manual', status: 'ok' });
    expect(run.items.map((i) => i.status)).toEqual(['ok', 'ok', 'ok']);
    const items = (await plan()).items;
    for (const item of items) {
      const { archives } = (await api().get(`/backups/items/${item.id}/archives`).expect(200)).body;
      expect(archives).toHaveLength(1);
      expect(item.lastSuccessAt).not.toBeNull();
    }
    const status = (await api().get('/backups/status').expect(200)).body;
    expect(status).toMatchObject({ configured: true, warnings: [], running: null });
    expect(status.lastSuccessAt).not.toBeNull();
    expect(
      status.items.find((i: { serviceId: string }) => i.serviceId === serviceId).lastStatus,
    ).toBe('ok');
  }, 90_000);

  it('restores a folder to a new folder', async () => {
    const folder = (await plan()).items.find((i) => i.kind === 'folder')!;
    const [archive] = (await api().get(`/backups/items/${folder.id}/archives`).expect(200)).body
      .archives;
    const started = await api()
      .post('/backups/restores', { itemId: folder.id, archive: archive.name, target: 'newFolder' })
      .expect(202);
    const restore = await finishedRestore(started.body.restoreId);
    expect(restore.job.status, restore.job.output.join('\n')).toBe('succeeded');
    const copy = join(restore.targetPath!, join(storage, 'docs').slice(1), 'letter.txt');
    expect(readFileSync(copy, 'utf8')).toBe('Dear …');
  }, 60_000);

  it('restores a service in place — the current version set aside until deleted', async () => {
    const service = (await plan()).items.find((i) => i.kind === 'service')! as BackupItem;
    const [archive] = (await api().get(`/backups/items/${service.id}/archives`).expect(200)).body
      .archives;
    writeFileSync(join(storage, 'test-hello', 'site', 'index.html'), 'broken');
    const started = await api()
      .post('/backups/restores', { itemId: service.id, archive: archive.name, target: 'inPlace' })
      .expect(202);
    const restore = await finishedRestore(started.body.restoreId);
    expect(restore.job.status, restore.job.output.join('\n')).toBe('succeeded');
    expect(restore.job.phase).toBe('done');
    expect(readFileSync(join(storage, 'test-hello', 'site', 'index.html'), 'utf8')).toBe(
      'version 1',
    );
    const [setAside] = restore.setAside;
    expect(readFileSync(join(setAside, 'index.html'), 'utf8')).toBe('broken');

    // Its backups can't be deleted while the restore keeps the previous version (its record would
    // go with them) — and nothing changed.
    const refused = await api().delete(`/backups/items/${service.id}?archives=delete`).expect(409);
    expect(refused.body.code).toBe('backup_set_aside_kept');
    expect((await plan()).items.find((i) => i.id === service.id)!.removed).toBe(false);

    const discarded = await api().delete(`/backups/restores/${restore.id}/previous`).expect(200);
    expect(discarded.body.setAsideDeleted).toBe(true);
    expect(existsSync(setAside)).toBe(false);
  }, 60_000);

  it('refuses a restore of an archive the item does not have', async () => {
    const folder = (await plan()).items.find((i) => i.kind === 'folder')!;
    await api()
      .post('/backups/restores', {
        itemId: folder.id,
        archive: `${folder.id}-2020-01-01T00:00:00`,
        target: 'newFolder',
      })
      .expect(404);
  });

  it('shows the passphrase again only with the app password', async () => {
    const wrong = await api().post('/backups/passphrase', { password: 'not it' }).expect(400);
    expect(wrong.body.errors[0]).toMatchObject({ field: 'password', code: 'wrong_password' });
    // Like sign-in: a wrong password delays the next try (1 s, doubling).
    await api().post('/backups/passphrase', { password: PASSWORD }).expect(429);
    await new Promise((r) => setTimeout(r, 1100));
    const right = await api().post('/backups/passphrase', { password: PASSWORD }).expect(200);
    expect(right.body.passphrase.split(' ')).toHaveLength(6);
    const audit = await app
      .get(PrismaService)
      .auditEvent.findMany({ where: { action: 'backup.passphrase' } });
    expect(audit.map((e) => e.outcome)).toEqual(['requested', 'success', 'requested', 'success']);
    expect(JSON.stringify(audit)).not.toContain(right.body.passphrase);
  });

  it('imports a scheduled run from the results file, audited as "system"', async () => {
    const folder = (await plan()).items.find((i) => i.kind === 'folder')!;
    const runId = randomUUID();
    const now = new Date().toISOString();
    appendFileSync(
      join(dir, 'backup', 'state', 'runs.jsonl'),
      `${JSON.stringify({
        type: 'run',
        runId,
        trigger: 'scheduled',
        itemId: null,
        status: 'failed',
        errorCode: null,
        startedAt: now,
        finishedAt: now,
        items: [
          {
            itemId: folder.id,
            status: 'failed',
            errorCode: 'source_missing',
            archive: null,
            originalBytes: null,
            addedBytes: null,
            warnings: [],
            archives: null,
          },
        ],
        output: [],
      })}\n`,
    );
    const run = await finishedRun(runId);
    expect(run).toMatchObject({ trigger: 'scheduled', status: 'failed' });
    const audit = await app
      .get(PrismaService)
      .auditEvent.findFirst({ where: { action: 'backup.run', username: 'system' } });
    expect(audit).toMatchObject({ outcome: 'failure', userId: null });
    const status = (await api().get('/backups/status').expect(200)).body;
    expect(status.warnings).toContain('lastRunFailed');
  }, 30_000);

  it('keeps nothing of a change the backup wrapper refuses — and later changes still work', async () => {
    // The wrapper's copy of the recipe has no backup any more (the app's still has): it refuses
    // the plan with the service in it.
    const metaFile = join(dir, 'catalog', 'test-hello', 'meta.json');
    const original = readFileSync(metaFile, 'utf8');
    const meta = JSON.parse(original);
    delete meta.backup;
    writeFileSync(metaFile, JSON.stringify(meta));
    try {
      const before = (await plan()).items.map((i) => [i.id, i.removed]);
      const service = (await plan()).items.find((i) => i.kind === 'service')!;
      const refused = await api().delete(`/backups/items/${service.id}`).expect(422);
      expect(refused.body.code).toBe('invalid_plan');
      expect((await plan()).items.map((i) => [i.id, i.removed])).toEqual(before);
    } finally {
      writeFileSync(metaFile, original);
    }
    await api()
      .put('/backups/plan', { retention: { daily: 7, weekly: 4, monthly: 6 } })
      .expect(200);
  });

  it('changes the schedule', async () => {
    const updated = await api()
      .put('/backups/plan', { schedule: { frequency: 'every6h', time: '01:30' } })
      .expect(200);
    expect(updated.body.schedule).toEqual({ frequency: 'every6h', time: '01:30' });
    const dropIn = readFileSync(
      join(dir, 'backup', 'systemd', 'homelab-backup.timer.d', 'schedule.conf'),
      'utf8',
    );
    expect(dropIn).toContain('OnCalendar=*-*-* 01,07,13,19:30:00');
  });

  it('removes an item keeping its backups, then deletes them when asked', async () => {
    const folder = (await plan()).items.find((i) => i.kind === 'folder')!;
    await api().delete(`/backups/items/${folder.id}`).expect(204);
    const kept = (await plan()).items.find((i) => i.id === folder.id)!;
    expect(kept.removed).toBe(true);
    expect(
      (await api().get(`/backups/items/${folder.id}/archives`).expect(200)).body.archives,
    ).toHaveLength(1);
    await api().delete(`/backups/items/${folder.id}?archives=delete`).expect(204);
    expect((await plan()).items.find((i) => i.id === folder.id)).toBeUndefined();
    const platform = (await plan()).items.find((i) => i.kind === 'platform')!;
    await api().delete(`/backups/items/${platform.id}`).expect(400);
  }, 60_000);

  it('adds a folder again', async () => {
    const res = await api()
      .post('/backups/items', { item: { kind: 'folder', path: join(storage, 'docs') } })
      .expect(201);
    expect(res.body).toMatchObject({ kind: 'folder', removed: false });
    await api()
      .post('/backups/items', { item: { kind: 'folder', path: join(storage, 'docs') } })
      .expect(400);
  });

  it('lets one privileged operation run at a time', async () => {
    const first = api().post('/backups/runs', {});
    const second = api().post('/backups/runs', {});
    const [a, b] = await Promise.all([first, second]);
    expect([a.status, b.status].sort((x, y) => x - y)).toEqual([202, 409]);
    await finishedRun((a.status === 202 ? a : b).body.runId);
  }, 90_000);
});
