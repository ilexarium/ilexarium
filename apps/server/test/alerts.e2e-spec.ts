import type { AddressInfo } from 'node:net';
import { PasswordHasher } from '@nestjs/authentication';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { AlertChannelsResponse, AlertsStatus } from '@laris/shared';
import request from 'supertest';
import { AlertRecords } from '../src/alerts/alert-records.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { UsersService } from '../src/users/users.service.js';
import { resetDatabase } from './database.js';
import { FakeNtfy, FakeSmtp } from './fake-notifiers.js';
import { testHasher } from './realtime-client.js';

// Health alerts end to end (docs/plans/health_alerts.md): the alerts API, Settings →
// Notifications with its secrets, and messages to a local fake ntfy and a fake mail server.
// The watcher is off in e2e (vitest.config.e2e.ts): alerts are opened through AlertRecords.

const PASSWORD = 'correct horse battery staple';
const TOKEN = 'tk_e2e-very-secret-token';
const MAIL_PASSWORD = 'mail-password-e2e';

describe('alerts (e2e)', () => {
  let app: NestExpressApplication;
  let origin: string;
  let cookie: string;
  let prisma: PrismaService;
  let records: AlertRecords;
  let ntfy: FakeNtfy;
  let smtp: FakeSmtp;

  const api = () => ({
    get: (path: string) => request(origin).get(`/api${path}`).set('Cookie', cookie),
    post: (path: string, body: object = {}) =>
      request(origin).post(`/api${path}`).set('Origin', origin).set('Cookie', cookie).send(body),
    put: (path: string, body: object) =>
      request(origin).put(`/api${path}`).set('Origin', origin).set('Cookie', cookie).send(body),
  });
  const topicUrl = () => `http://127.0.0.1:${ntfy.port}/laris-e2e-topic`;
  const emailSettings = (overrides: object = {}) => ({
    enabled: true,
    host: '127.0.0.1',
    port: smtp.port,
    username: 'alerts',
    password: MAIL_PASSWORD,
    from: 'laris@example.com',
    to: 'me@example.com',
    ...overrides,
  });

  beforeAll(async () => {
    ntfy = await new FakeNtfy().listen();
    smtp = await new FakeSmtp({ user: 'alerts', pass: MAIL_PASSWORD }).listen();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PasswordHasher)
      .useValue(testHasher)
      .compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.listen(0, '127.0.0.1');
    origin = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);
    records = app.get(AlertRecords);
  }, 60_000);

  beforeEach(async () => {
    await resetDatabase(prisma);
    // A fresh copy of the open alerts, matching the emptied table.
    (records as unknown as { openAlerts: Map<string, unknown> }).openAlerts.clear();
    ntfy.messages.length = 0;
    ntfy.status = 200;
    smtp.mails.length = 0;
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
  });

  afterAll(async () => {
    await app?.close();
    await ntfy?.close();
    await smtp?.close();
  });

  it('needs a session', async () => {
    await request(origin).get('/api/alerts').expect(401);
    await request(origin).get('/api/alerts/channels').expect(401);
  });

  it('lists open and closed alerts; acknowledging stops reminders', async () => {
    expect((await api().get('/alerts').expect(200)).body).toEqual({
      open: [],
      closed: [],
      deliveryFailure: null,
    });
    await records.reconcile(
      ['serviceDown'],
      [
        {
          kind: 'serviceDown',
          subject: 'hl-immich-server-1',
          severity: 'critical',
          details: { app: 'immich' },
        },
      ],
    );
    await records.reconcile(
      ['backup'],
      [{ kind: 'backup', subject: 'lowSpace', severity: 'warning', details: {} }],
    );
    await records.reconcile(['backup'], []);
    const status = (await api().get('/alerts').expect(200)).body as AlertsStatus;
    expect(status.open).toEqual([
      expect.objectContaining({
        kind: 'serviceDown',
        app: 'immich',
        acknowledgedAt: null,
      }),
    ]);
    expect(status.closed).toEqual([
      expect.objectContaining({ kind: 'backup', warning: 'lowSpace' }),
    ]);

    await api().post(`/alerts/${status.open[0].id}/acknowledge`).expect(204);
    await api().post(`/alerts/${status.open[0].id}/acknowledge`).expect(204);
    const after = (await api().get('/alerts').expect(200)).body as AlertsStatus;
    expect(after.open[0]).toMatchObject({ acknowledgedBy: 'owner' });
    await api().post(`/alerts/${status.closed[0].id}/acknowledge`).expect(404);
    await api().post('/alerts/not-a-uuid/acknowledge').expect(400);
  });

  it('keeps ntfy’s topic and token encrypted, never sends them back, audits without them', async () => {
    expect((await api().get('/alerts/channels').expect(200)).body).toEqual({
      email: null,
      ntfy: null,
    });
    await api()
      .put('/alerts/channels/ntfy', { enabled: true, topicUrl: topicUrl(), token: TOKEN })
      .expect(204);
    const view = (await api().get('/alerts/channels').expect(200)).body as AlertChannelsResponse;
    expect(view.ntfy).toEqual({ enabled: true, topicSet: true, tokenSet: true, lastFailure: null });
    expect(JSON.stringify(view)).not.toContain('laris-e2e-topic');

    const row = await prisma.alertChannel.findUniqueOrThrow({ where: { kind: 'ntfy' } });
    const stored = Buffer.from(row.secrets!).toString('latin1');
    expect(stored).not.toContain(TOKEN);
    expect(stored).not.toContain('laris-e2e-topic');
    expect(JSON.stringify(row.settings)).not.toContain('laris-e2e-topic');

    const audit = await prisma.auditEvent.findMany({ where: { action: 'alerts.channel.update' } });
    expect(audit.map((a) => a.details)).toEqual([{ channel: 'ntfy', enabled: true }]);

    // Left out: kept. null: the token is removed.
    await api().put('/alerts/channels/ntfy', { enabled: false }).expect(204);
    expect(
      ((await api().get('/alerts/channels')).body as AlertChannelsResponse).ntfy,
    ).toMatchObject({
      enabled: false,
      topicSet: true,
      tokenSet: true,
    });
    await api().put('/alerts/channels/ntfy', { enabled: true, token: null }).expect(204);
    expect(
      ((await api().get('/alerts/channels')).body as AlertChannelsResponse).ntfy,
    ).toMatchObject({
      tokenSet: false,
    });
  });

  it('sends a test through ntfy, with the token', async () => {
    await api().post('/alerts/channels/ntfy/test').expect(409);
    await api()
      .put('/alerts/channels/ntfy', { enabled: true, topicUrl: topicUrl(), token: TOKEN })
      .expect(204);
    expect((await api().post('/alerts/channels/ntfy/test').expect(200)).body).toEqual({
      sent: true,
      problem: null,
    });
    expect(ntfy.messages).toEqual([
      expect.objectContaining({
        path: '/',
        authorization: `Bearer ${TOKEN}`,
        body: expect.objectContaining({ topic: 'laris-e2e-topic', title: 'Test message' }),
      }),
    ]);
    const audit = await prisma.auditEvent.findMany({ where: { action: 'alerts.channel.test' } });
    expect(audit).toEqual([
      expect.objectContaining({ outcome: 'success', details: { channel: 'ntfy' } }),
    ]);
  });

  it('a failed delivery is shown in the settings and on the Alerts page', async () => {
    await api().put('/alerts/channels/ntfy', { enabled: true, topicUrl: topicUrl() }).expect(204);
    ntfy.status = 403;
    expect((await api().post('/alerts/channels/ntfy/test').expect(200)).body).toEqual({
      sent: false,
      problem: 'loginRefused',
    });
    const view = (await api().get('/alerts/channels')).body as AlertChannelsResponse;
    expect(view.ntfy!.lastFailure).toMatchObject({ channel: 'ntfy', problem: 'loginRefused' });
    expect(((await api().get('/alerts')).body as AlertsStatus).deliveryFailure).toMatchObject({
      channel: 'ntfy',
      problem: 'loginRefused',
    });
    // One that gets through clears it.
    ntfy.status = 200;
    await api().post('/alerts/channels/ntfy/test').expect(200);
    expect(((await api().get('/alerts')).body as AlertsStatus).deliveryFailure).toBeNull();
  });

  it('sends by email through a mail server on this machine; the password stays on the server', async () => {
    await api()
      .put('/alerts/channels/email', emailSettings({ password: undefined }))
      .expect(400)
      .expect((res) => expect(res.body.code).toBe('password_required'));
    await api().put('/alerts/channels/email', emailSettings()).expect(204);
    const view = (await api().get('/alerts/channels')).body as AlertChannelsResponse;
    expect(view.email).toEqual({
      enabled: true,
      host: '127.0.0.1',
      port: smtp.port,
      username: 'alerts',
      passwordSet: true,
      from: 'laris@example.com',
      to: 'me@example.com',
      lastFailure: null,
    });
    const row = await prisma.alertChannel.findUniqueOrThrow({ where: { kind: 'email' } });
    expect(Buffer.from(row.secrets!).toString('latin1')).not.toContain(MAIL_PASSWORD);
    // Saved again without a password: the stored one is kept.
    await api()
      .put('/alerts/channels/email', emailSettings({ password: undefined }))
      .expect(204);
    expect((await api().post('/alerts/channels/email/test').expect(200)).body).toEqual({
      sent: true,
      problem: null,
    });
    expect(smtp.mails).toHaveLength(1);
    expect(smtp.mails[0]).toMatchObject({ user: 'alerts', to: ['me@example.com'] });
    expect(smtp.mails[0].data).toContain('Subject: Test message');
  });

  it('refuses addresses the app never sends to', async () => {
    for (const url of ['http://169.254.169.254/latest', 'http://[fe80::1]/t']) {
      await api()
        .put('/alerts/channels/ntfy', { enabled: true, topicUrl: url })
        .expect(400)
        .expect((res) => expect(res.body.code, url).toBe('address_refused'));
    }
    await api()
      .put('/alerts/channels/email', emailSettings({ host: '169.254.169.254', port: 25 }))
      .expect(400)
      .expect((res) => expect(res.body.code).toBe('address_refused'));
  });

  it('accepts a server on this machine, any port (a self-hosted ntfy)', async () => {
    await api()
      .put('/alerts/channels/ntfy', { enabled: true, topicUrl: 'http://127.0.0.1:8080/laris' })
      .expect(204);
  });

  it('validates the settings', async () => {
    await api()
      .put('/alerts/channels/ntfy', { enabled: true, topicUrl: 'ftp://ntfy.sh/topic' })
      .expect(400);
    await api()
      .put('/alerts/channels/ntfy', { enabled: true, topicUrl: 'https://user:pw@ntfy.sh/t' })
      .expect(400);
    await api().put('/alerts/channels/ntfy', { enabled: true }).expect(400);
    // Switched off, no topic yet: saved as off.
    await api().put('/alerts/channels/ntfy', { enabled: false }).expect(204);
    expect(((await api().get('/alerts/channels')).body as AlertChannelsResponse).ntfy).toEqual({
      enabled: false,
      topicSet: false,
      tokenSet: false,
      lastFailure: null,
    });
    await api()
      .put('/alerts/channels/email', emailSettings({ to: 'not an address' }))
      .expect(400);
    await api()
      .put('/alerts/channels/email', emailSettings({ port: 70000 }))
      .expect(400);
    await api()
      .put('/alerts/channels/email', { ...emailSettings(), extra: 1 })
      .expect(400);
  });

  it('sends a message when an alert opens and when it closes', async () => {
    await api().put('/alerts/channels/ntfy', { enabled: true, topicUrl: topicUrl() }).expect(204);
    const condition = {
      kind: 'serviceDown' as const,
      subject: 'laris-postgres',
      severity: 'critical' as const,
      details: {},
    };
    await records.reconcile(['serviceDown'], [condition]);
    await vi.waitFor(() => expect(ntfy.messages).toHaveLength(1));
    expect(ntfy.messages[0].body).toMatchObject({
      title: 'laris-postgres has stopped',
      priority: 4,
    });
    expect((await prisma.alert.findFirstOrThrow()).lastSentAt).not.toBeNull();
    await records.reconcile(['serviceDown'], []);
    await vi.waitFor(() => expect(ntfy.messages).toHaveLength(2));
    expect(ntfy.messages[1].body).toMatchObject({
      title: 'Resolved: laris-postgres has stopped',
    });
  });
});
