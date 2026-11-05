import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PasswordHasher } from '@nestjs/authentication';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { DisksStatus } from '@laris/shared';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { UsersService } from '../src/users/users.service.js';
import { resetDatabase } from './database.js';
import { testHasher } from './realtime-client.js';

// Disks end to end: the app, the executor in direct mode and the real disk wrapper
// (system/programs/laris-disk.mts) — against a pretend host (its /sys, udev database,
// /dev/disk/by-uuid and mountinfo), the wrapper pretending its mounts (no systemd).

const WRAPPER_CONFIG = resolve('.dev/wrappers.test.json');
const PASSWORD = 'correct horse battery staple';
const PHOTOS = '4E21-9A07';
const ROOT = '6f1e2d3c-0000-4000-8000-000000000001';

/** A mount request at /mnt/<name>. */
const mount = (uuid: string, name: string) => ({
  uuid,
  mountPoint: `/mnt/${name}`,
  makeMine: false,
});

describe('disks (e2e)', () => {
  let app: NestExpressApplication;
  let origin: string;
  let cookie: string;
  let dir: string;
  let host: string;

  const api = () => ({
    get: (path: string) => request(origin).get(`/api${path}`).set('Cookie', cookie),
    post: (path: string, body: object) =>
      request(origin).post(`/api${path}`).set('Origin', origin).set('Cookie', cookie).send(body),
    delete: (path: string) =>
      request(origin).delete(`/api${path}`).set('Origin', origin).set('Cookie', cookie),
  });

  const status = async () => (await api().get('/disks').expect(200)).body as DisksStatus;
  const partition = async (device: string) =>
    (await status()).disks.flatMap((d) => d.partitions).find((p) => p.device === device)!;

  /** A disk in the pretend host. */
  function addDisk(name: string, number: string, parts: [string, string, string, string][]) {
    const block = join(host, 'sys/class/block');
    mkdirSync(join(block, name), { recursive: true });
    writeFileSync(join(block, name, 'dev'), `${number}\n`);
    writeFileSync(join(block, name, 'size'), '2000\n');
    for (const [part, partNumber, fsType, uuid] of parts) {
      mkdirSync(join(block, name, part));
      writeFileSync(join(block, name, part, 'dev'), `${partNumber}\n`);
      writeFileSync(join(block, name, part, 'partition'), '1\n');
      writeFileSync(join(block, name, part, 'size'), '1000\n');
      symlinkSync(`${name}/${part}`, join(block, part));
      writeFileSync(
        join(host, 'run/udev/data', `b${partNumber}`),
        `E:ID_FS_TYPE=${fsType}\nE:ID_FS_UUID=${uuid}\nE:ID_FS_LABEL=${part}\n`,
      );
      symlinkSync(`../../${part}`, join(host, 'dev/disk/by-uuid', uuid));
    }
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'disks-e2e-'));
    host = join(dir, 'host');
    for (const folder of ['sys/class/block', 'run/udev/data', 'dev/disk/by-uuid', 'proc/self']) {
      mkdirSync(join(host, folder), { recursive: true });
    }
    mkdirSync(join(dir, 'mnt', 'mnt'), { recursive: true });
    mkdirSync(join(dir, 'srv'));
    addDisk('vda', '253:0', [['vda1', '253:1', 'ext4', ROOT]]);
    addDisk('sdx', '8:208', [
      ['sdx1', '8:209', 'exfat', PHOTOS],
      ['sdx2', '8:210', 'ntfs', '01D9A1B2C3D4E5F6'],
    ]);
    writeFileSync(join(host, 'proc/self/mountinfo'), '21 1 253:1 / / rw - ext4 /dev/vda1 rw\n');
    writeFileSync(join(host, 'proc/swaps'), 'Filename Type Size Used Priority\n');
    mkdirSync(resolve('.dev'), { recursive: true });
    writeFileSync(
      WRAPPER_CONFIG,
      JSON.stringify({
        protectedPaths: [],
        dockerBin: '/usr/bin/docker',
        lockFile: join(dir, 'compose.lock'),
        home: homedir(),
        disk: {
          dev: {
            root: host,
            mountRoot: join(dir, 'mnt'),
            unitDir: join(dir, 'units'),
            backupPlan: join(dir, 'backup.json'),
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
    rmSync(WRAPPER_CONFIG, { force: true }); // other e2e files get the defaults again
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists the disks: the system disk last, every partition with its state', async () => {
    const { disks, disconnected } = await status();
    expect(disks.map((d) => [d.device, d.system])).toEqual([
      ['sdx', false],
      ['vda', true],
    ]);
    expect(disks[0].partitions.map((p) => [p.device, p.state, p.fsType])).toEqual([
      ['sdx1', 'available', 'exfat'],
      ['sdx2', 'unsupported', 'ntfs'],
    ]);
    expect(disks[1].partitions[0]).toMatchObject({ state: 'system', mountPoint: '/' });
    expect(disconnected).toEqual([]);
  });

  it('mounts a disk at a folder and unmounts it, audited', async () => {
    const where = '/mnt/photos';
    const mounted = await api().post('/disks/mount', mount(PHOTOS, 'photos')).expect(200);
    expect(mounted.body).toEqual({ mountPoint: where });
    expect(await partition('sdx1')).toMatchObject({
      state: 'mounted',
      mountPoint: where,
      managed: true,
      usedForBackups: false,
    });
    expect(readFileSync(join(dir, 'units', 'mnt-photos.mount'), 'utf8')).toContain(
      `What=/dev/disk/by-uuid/${PHOTOS}`,
    );

    await api().post('/disks/unmount', { mountPoint: '/mnt/photos' }).expect(204);
    expect(await partition('sdx1')).toMatchObject({ state: 'available', managed: false });

    const audit = await app.get(PrismaService).auditEvent.findMany({
      where: { action: { in: ['disk.mount', 'disk.unmount'] } },
      orderBy: { id: 'asc' },
    });
    expect(audit.map((e) => [e.action, e.outcome, e.username])).toEqual([
      ['disk.mount', 'requested', 'owner'],
      ['disk.mount', 'success', 'owner'],
      ['disk.unmount', 'requested', 'owner'],
      ['disk.unmount', 'success', 'owner'],
    ]);
  });

  it('refuses the system disk, other filesystems, a disk in use and a bad request', async () => {
    const system = await api().post('/disks/mount', mount(ROOT, 'root')).expect(422);
    expect(system.body.code).toBe('system_disk');
    const ntfs = await api().post('/disks/mount', mount('01D9A1B2C3D4E5F6', 'win')).expect(422);
    expect(ntfs.body.code).toBe('unsupported_filesystem');
    await api().post('/disks/mount', mount('nope', 'x')).expect(404);
    await api()
      .post('/disks/mount', { ...mount(PHOTOS, 'x'), mountPoint: '/etc/x' })
      .expect(400);
    await api()
      .post('/disks/mount', { ...mount(PHOTOS, 'x'), options: 'exec' })
      .expect(400);

    await api().post('/disks/mount', mount(PHOTOS, 'photos')).expect(200);
    const again = await api().post('/disks/mount', mount(PHOTOS, 'other')).expect(409);
    expect(again.body.code).toBe('disk_in_use');
    await api().post('/disks/unmount', { mountPoint: '/mnt/photos' }).expect(204);
  });

  it('unmounts only disks mounted here, never the backup disk', async () => {
    const unknown = await api().post('/disks/unmount', { mountPoint: '/mnt/nothing' }).expect(404);
    expect(unknown.body.code).toBe('not_managed');
    await api().post('/disks/unmount', { mountPoint: '/etc' }).expect(400);

    await api().post('/disks/mount', mount(PHOTOS, 'photos')).expect(200);
    const prisma = app.get(PrismaService);
    await prisma.backupPlan.create({
      data: {
        id: 1,
        destination: '/mnt/photos',
        repositoryId: 'r'.repeat(64),
        schedule: { frequency: 'daily', time: '03:00' },
        retention: { daily: 7, weekly: 4, monthly: 6 },
      },
    });
    expect((await partition('sdx1')).usedForBackups).toBe(true);
    const refused = await api().post('/disks/unmount', { mountPoint: '/mnt/photos' }).expect(409);
    expect(refused.body.code).toBe('used_for_backups');
    await prisma.backupPlan.delete({ where: { id: 1 } });
    await api().post('/disks/unmount', { mountPoint: '/mnt/photos' }).expect(204);
  });

  it('needs a session', async () => {
    await request(origin).get('/api/disks').expect(401);
    await request(origin)
      .post('/api/disks/mount')
      .set('Origin', origin)
      .send(mount(PHOTOS, 'x'))
      .expect(401);
  });
});
