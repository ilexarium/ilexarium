import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { PasswordHasher } from '@nestjs/authentication';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { type Client, connectSignedIn, testHasher } from './realtime-client.js';

// The process list end to end: the `processes` topic from this machine's /proc, and the API's
// refusals through the executor in direct mode and the real process wrapper. The wrapper's config
// makes this test's user a person and the app's user someone else. Ending a real process is
// tested with the wrapper itself (system/wrappers/laris-process.spec.ts starts one to end):
// here, only src/executor/ may start a program (lint).

const WRAPPER_CONFIG = resolve('.dev/wrappers.test.json');
const ME = process.getuid?.() ?? 0;
const PERSON = ME >= 1000 && ME <= 60000;

/** The real start time of a process (field 22 of /proc/<pid>/stat). */
function startTicks(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return stat
    .slice(stat.lastIndexOf(')') + 1)
    .trim()
    .split(/\s+/)[19];
}

describe.skipIf(!PERSON)('processes (e2e)', () => {
  let app: NestExpressApplication;
  let client: Client;
  let origin: string;
  let cookie: string;
  /** A person's process that must never be ended: this test itself. */
  const self = process.pid;

  beforeAll(() => {
    mkdirSync(resolve('.dev'), { recursive: true });
    writeFileSync(
      WRAPPER_CONFIG,
      JSON.stringify({
        catalogDir: resolve('test/fixtures/catalog'),
        storageRoots: [resolve('.dev/srv')],
        serviceRoot: resolve('.dev/srv'),
        reservedPorts: [22],
        protectedPaths: [],
        dockerBin: '/usr/bin/docker',
        home: homedir(),
        process: { appUid: 0, minUid: ME, dev: { procRoot: '/proc' } },
      }),
    );
  });

  afterAll(() => rmSync(WRAPPER_CONFIG, { force: true })); // other e2e files get the defaults again

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PasswordHasher)
      .useValue(testHasher)
      .compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    client = await connectSignedIn(app);
    origin = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    const login = await request(origin)
      .post('/api/auth/login')
      .set('Origin', origin)
      .send({ username: 'owner', password: 'correct horse battery' })
      .expect(200);
    cookie = ([] as string[])
      .concat(login.headers['set-cookie'] ?? [])
      .find((c) => c.startsWith('__Host-sid='))!
      .split(';')[0];
  });

  afterEach(async () => {
    client?.socket.terminate();
    await app?.close();
  });

  const end = (body: object) =>
    request(origin)
      .post('/api/processes/signal')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send(body);

  it('lists this machine’s processes live — this test among them, endable — PID 1 not', async () => {
    client.send({ event: 'subscribe', data: { topic: 'processes' } });
    const [snapshot] = await client.received(1, 5000);
    expect(snapshot.event).toBe('processes:snapshot');
    if (snapshot.event !== 'processes:snapshot') return;
    const me = snapshot.data.processes.find((p) => p.pid === self);
    expect(me).toMatchObject({
      uid: ME,
      startTicks: startTicks(self),
      kernel: false,
      system: false,
      container: null,
      endable: true,
    });
    expect(me!.command).toContain('node');
    expect(snapshot.data.processes.find((p) => p.pid === 1)).toMatchObject({ endable: false });

    const [, update] = await client.received(2, 5000); // one reading (2 s) later
    expect(update.event).toBe('processes:update');
  });

  it('refuses a stale start time, PID 1 and bad requests, audited — nothing ended', async () => {
    const stale = String(Number(startTicks(self)) + 1);
    const notFound = await end({ pid: self, startTicks: stale, signal: 'TERM' }).expect(404);
    expect(notFound.body.code).toBe('process_not_found');
    const protectedOne = await end({ pid: 1, startTicks: startTicks(1), signal: 'KILL' }).expect(
      403,
    );
    expect(protectedOne.body.code).toBe('process_protected');
    await end({ pid: self, startTicks: startTicks(self), signal: 'HUP' }).expect(400);
    await end({ pid: -1, startTicks: '1', signal: 'TERM' }).expect(400);
    await end({ pid: self, startTicks: startTicks(self), signal: 'TERM', uid: 0 }).expect(400);
    // The app's first checks refused these: nothing reached the executor or the audit log.
    const audit = await app
      .get(PrismaService)
      .auditEvent.count({ where: { action: 'process.end' } });
    expect(audit).toBe(0);
  });

  it('needs a session', async () => {
    await request(origin)
      .post('/api/processes/signal')
      .set('Origin', origin)
      .send({ pid: self, startTicks: startTicks(self), signal: 'TERM' })
      .expect(401);
  });
});
