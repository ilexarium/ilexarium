import { PasswordHasher } from '@nestjs/authentication';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { activityResponseSchema } from '@laris/shared';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { type SignedIn, signIn, testHasher } from './realtime-client.js';

// The dashboard's "Recent activity" (docs/plans/dashboard_v2.md): the audit log's successes of a
// few actions, backup runs and alerts, merged — and nothing of the audit log's other details.
describe('activity (e2e)', () => {
  let app: NestExpressApplication;
  let session: SignedIn;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PasswordHasher)
      .useValue(testHasher)
      .compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    session = await signIn(app);
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  const RUN_ID = '01990000-0000-7000-8000-000000000001';
  const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

  it('needs a session', async () => {
    await request(session.origin).get('/api/activity').expect(401);
  });

  it('merges actions, backup runs and alerts, newest first, with only their safe parts', async () => {
    await prisma.auditEvent.createMany({
      data: [
        {
          at: minutesAgo(50),
          action: 'container.restart',
          outcome: 'success',
          username: 'owner',
          ip: '192.168.1.20',
          details: { container: 'immich-server-1', secretish: 'never shown' },
        },
        {
          at: minutesAgo(40),
          action: 'container.stop',
          outcome: 'failure',
          details: { container: 'x' },
        },
        {
          at: minutesAgo(30),
          action: 'files.delete',
          outcome: 'success',
          details: { path: '/home/a' },
        },
      ],
    });
    await prisma.backupRun.create({
      data: {
        id: RUN_ID,
        trigger: 'scheduled',
        status: 'ok',
        output: 'borg output',
        startedAt: minutesAgo(25),
        finishedAt: minutesAgo(20),
      },
    });
    await prisma.alert.create({
      data: {
        kind: 'serviceDown',
        subject: 'immich-server-1',
        severity: 'critical',
        details: { app: 'immich' },
        openedAt: minutesAgo(10),
        closedAt: minutesAgo(5),
      },
    });

    const res = await request(session.origin)
      .get('/api/activity')
      .set('Cookie', session.cookie)
      .expect(200);
    // Backup runs the e2e wrapper config's own results file brings in are left aside.
    const items = activityResponseSchema
      .parse(res.body)
      .items.filter((i) => i.source !== 'backup' || i.id === RUN_ID);
    expect(items.map((i) => (i.source === 'alert' ? `alert.${i.event}` : i.source))).toEqual([
      'alert.closed',
      'alert.opened',
      'backup',
      'action',
    ]);
    expect(items[0].source === 'alert' && items[0].alert.app).toBe('immich');
    expect(items[3]).toMatchObject({
      action: 'container.restart',
      username: 'owner',
      subject: 'immich-server-1',
    });
    const text = JSON.stringify(res.body);
    for (const hidden of ['192.168', 'never shown', 'borg output', '/home/a']) {
      expect(text).not.toContain(hidden);
    }
  });
});
