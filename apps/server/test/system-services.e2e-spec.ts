import { connect } from 'node:net';
import { PasswordHasher } from '@nestjs/authentication';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { type Client, connectSignedIn, testHasher } from './realtime-client.js';

// System services end to end, through the helper on the development SSH server (dev/sshd): its
// fake systemctl has sample units (no systemd in a container), and changes them only as root —
// laris-root, through anna's sudo once unlocked. Skipped when the SSH server isn't running
// (npm run db:up starts it).

const ANNA = { username: 'anna', password: 'anna-dev-password' };

const sshdUp = await new Promise<boolean>((done) => {
  const socket = connect(2222, '127.0.0.1');
  socket.once('connect', () => (socket.destroy(), done(true)));
  socket.once('error', () => done(false));
});

describe.skipIf(!sshdUp)('system services (e2e)', () => {
  let app: NestExpressApplication;
  let client: Client;
  let prisma: PrismaService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PasswordHasher)
      .useValue(testHasher)
      .compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    client = await connectSignedIn(app);
    prisma = app.get(PrismaService);
  });

  afterEach(async () => {
    client?.socket.terminate();
    await app?.close();
  });

  const get = (path: string) =>
    request(client.session!.origin).get(`/api${path}`).set('Cookie', client.session!.cookie);
  const post = (path: string, body: object = {}) =>
    request(client.session!.origin)
      .post(`/api${path}`)
      .set('Origin', client.session!.origin)
      .set('Cookie', client.session!.cookie)
      .send(body);
  const signIn = () => post('/files/session', ANNA).expect(200);
  const unlock = () => post('/files/session/sudo', { password: ANNA.password }).expect(200);
  const audit = () =>
    prisma.auditEvent.findMany({
      where: { action: { startsWith: 'system_service.' } },
      orderBy: [{ at: 'asc' }, { id: 'asc' }],
    });

  it('needs a Linux session (403, never 401)', async () => {
    const res = await get('/system/services');
    expect([res.status, res.body.code]).toEqual([403, 'linux_session_required']);
    const act = await post('/system/services/nginx.service/restart');
    expect([act.status, act.body.code]).toEqual([403, 'linux_session_required']);
  });

  it('lists the units and shows one, as the account', async () => {
    await signIn();
    const { body } = await get('/system/services').expect(200);
    expect(body.truncated).toBe(false);
    const byName = Object.fromEntries(
      (body.services as { name: string }[]).map((s) => [s.name, s]),
    );
    expect(byName['proton.VPN.service']).toMatchObject({ active: 'failed', protection: null });
    expect(byName['laris.service']).toMatchObject({ protection: 'laris' });
    expect(byName['ssh.service']).toMatchObject({ protection: 'essential', enabled: 'enabled' });

    const details = await get('/system/services/proton.VPN.service').expect(200);
    expect(details.body).toMatchObject({
      name: 'proton.VPN.service',
      active: 'failed',
      result: 'exit-code',
      exitStatus: 1,
      unitFile: '/usr/lib/systemd/system/proton.VPN.service',
    });
    const missing = await get('/system/services/nope.service');
    expect([missing.status, missing.body.code]).toEqual([404, 'service_not_found']);
    const bad = await get('/system/services/--all');
    expect(bad.status).toBe(400);
  });

  it('restarts and stops through the account’s sudo only, recorded; protected ones refused', async () => {
    await signIn();
    const locked = await post('/system/services/backup-sync.service/start');
    expect([locked.status, locked.body.code]).toEqual([403, 'sudo_required']);

    await unlock();
    await post('/system/services/backup-sync.service/start').expect(204);
    expect((await get('/system/services/backup-sync.service')).body.active).toBe('active');
    await post('/system/services/backup-sync.service/stop').expect(204);
    expect((await get('/system/services/backup-sync.service')).body.active).toBe('inactive');

    const own = await post('/system/services/laris.service/restart');
    expect([own.status, own.body.code]).toEqual([403, 'service_protected']);
    const needed = await post('/system/services/ssh.service/stop');
    expect([needed.status, needed.body.code]).toEqual([403, 'service_protected']);
    await post('/system/services/ssh.service/restart').expect(204);

    expect((await audit()).map((e) => [e.action, e.outcome])).toEqual([
      ['system_service.start', 'requested'],
      ['system_service.start', 'failure'],
      ['system_service.start', 'requested'],
      ['system_service.start', 'success'],
      ['system_service.stop', 'requested'],
      ['system_service.stop', 'success'],
      ['system_service.restart', 'requested'],
      ['system_service.restart', 'success'],
    ]);
  });
});
