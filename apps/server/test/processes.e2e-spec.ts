import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { PasswordHasher } from '@nestjs/authentication';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Client as SshClient } from 'ssh2';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { type Client, connectSignedIn, testHasher } from './realtime-client.js';

// The process list end to end: the `processes` topic from this machine's /proc, and ending
// processes as a Linux account through its helper on the development SSH server (dev/sshd, which
// shares this machine's PIDs and runs the repo's helper): anna ends her own; bob's through her
// sudo once unlocked (her rule allows `kill`); bob has no sudo. Skipped when the SSH server isn't
// running (npm run db:up starts it).

const ANNA = { username: 'anna', password: 'anna-dev-password' };
const BOB = { username: 'bob', password: 'bob-dev-password' };
const ME = process.getuid?.() ?? 0;

const sshdUp = await new Promise<boolean>((done) => {
  const socket = connect(2222, '127.0.0.1');
  socket.once('connect', () => (socket.destroy(), done(true)));
  socket.once('error', () => done(false));
});

/** The real start time of a process (field 22 of /proc/<pid>/stat). */
function startTicks(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return stat
    .slice(stat.lastIndexOf(')') + 1)
    .trim()
    .split(/\s+/)[19];
}

const running = (pid: number) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch {
    return false;
  }
};

async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 50 && running(pid); i++) await new Promise((r) => setTimeout(r, 100));
  return !running(pid);
}

/** Runs a command as a dev SSH server account (the test's own connection, not the app's). */
function sshRun(account: { username: string; password: string }, command: string): Promise<string> {
  return new Promise((ok, fail) => {
    const client = new SshClient();
    client
      .on('ready', () =>
        client.exec(command, (error, channel) => {
          if (error) return fail(error);
          let out = '';
          channel.on('data', (chunk: Buffer) => (out += chunk.toString()));
          channel.stderr.resume();
          channel.on('close', () => (client.end(), ok(out)));
        }),
      )
      .on('error', fail)
      .connect({ host: '127.0.0.1', port: 2222, ...account, hostVerifier: () => true });
  });
}

/** A `sleep` of that account, by PID: on this machine, since the SSH server shares its PIDs. */
async function sleeper(account: { username: string; password: string }): Promise<number> {
  const pid = Number(await sshRun(account, 'sleep 300 >/dev/null 2>&1 & echo $!'));
  expect(existsSync(`/proc/${pid}`), 'dev/sshd must share the host’s PIDs (pid: host)').toBe(true);
  return pid;
}

describe.skipIf(!sshdUp)('processes (e2e)', () => {
  let app: NestExpressApplication;
  let client: Client;
  let prisma: PrismaService;
  const started: { account: typeof ANNA; pid: number }[] = [];

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
    for (const { account, pid } of started.splice(0)) {
      if (running(pid)) await sshRun(account, `kill ${pid}`);
    }
  });

  const post = (path: string, body: object) =>
    request(client.session!.origin)
      .post(`/api${path}`)
      .set('Origin', client.session!.origin)
      .set('Cookie', client.session!.cookie)
      .send(body);
  const signInAs = (account: typeof ANNA) => post('/files/session', account).expect(200);
  const end = (body: object) => post('/processes/signal', body);
  const unlock = (password: string) => post('/files/session/sudo', { password });
  const linuxSession = () =>
    request(client.session!.origin)
      .get('/api/files/session')
      .set('Cookie', client.session!.cookie)
      .expect(200)
      .then((res) => res.body.session as { sudoUntil: string | null } | null);
  const sleeperOf = async (account: typeof ANNA) => {
    const pid = await sleeper(account);
    started.push({ account, pid });
    return { pid, startTicks: startTicks(pid) };
  };
  const audit = () =>
    prisma.auditEvent.findMany({
      where: { action: 'process.end' },
      orderBy: [{ at: 'asc' }, { id: 'asc' }],
    });

  it('lists this machine’s processes live, with htop’s columns and the header’s summary', async () => {
    client.send({ event: 'subscribe', data: { topic: 'processes' } });
    const [snapshot] = await client.received(1, 5000);
    expect(snapshot.event).toBe('processes:snapshot');
    if (snapshot.event !== 'processes:snapshot') return;
    const me = snapshot.data.processes.find((p) => p.pid === process.pid);
    expect(me).toMatchObject({ uid: ME, startTicks: startTicks(process.pid), kernel: false });
    expect(me!.command).toContain('node');
    expect(me!.virtualBytes).toBeGreaterThan(me!.memoryBytes);
    expect(me!.cpuSeconds).toBeGreaterThan(0);
    expect(snapshot.data.summary.cores).toBeGreaterThanOrEqual(1);
    expect(snapshot.data.summary.load).toHaveLength(3);
    expect(snapshot.data.summary.memory.totalBytes).toBeGreaterThan(0);

    const [, update] = await client.received(2, 5000); // one reading (2 s) later
    expect(update.event).toBe('processes:update');
  });

  it('needs a Linux session (403, never 401) — nothing recorded', async () => {
    const res = await end({
      pid: process.pid,
      startTicks: startTicks(process.pid),
      signal: 'TERM',
    });
    expect([res.status, res.body.code]).toEqual([403, 'linux_session_required']);
    expect(await audit()).toHaveLength(0);
  });

  it('ends the account’s own process; another’s only through its unlocked sudo', async () => {
    const own = await sleeperOf(ANNA);
    const others = await sleeperOf(BOB);
    await signInAs(ANNA);

    const locked = await end({ ...others, signal: 'KILL' });
    expect([locked.status, locked.body.code]).toEqual([403, 'sudo_required']);
    expect(running(others.pid)).toBe(true);

    await end({ ...own, signal: 'TERM' }).expect(204);
    expect(await gone(own.pid)).toBe(true);

    expect((await audit()).map((e) => [e.outcome, e.details])).toEqual([
      [
        'requested',
        expect.objectContaining({ pid: others.pid, linuxUser: 'anna', asAdministrator: true }),
      ],
      ['failure', expect.objectContaining({ reason: 'sudo_required' })],
      [
        'requested',
        expect.objectContaining({ pid: own.pid, signal: 'TERM', asAdministrator: false }),
      ],
      ['success', expect.objectContaining({ pid: own.pid })],
    ]);
  });

  it('unlocks sudo with the account’s password (a wrong one refused), then ends another’s', async () => {
    const others = await sleeperOf(BOB);
    await signInAs(ANNA);
    expect((await linuxSession())?.sudoUntil).toBeNull();

    const wrong = await unlock('nope');
    expect([wrong.status, wrong.body.code]).toEqual([403, 'sudo_password_wrong']);
    const unlocked = await unlock(ANNA.password).expect(200);
    expect(Date.parse(unlocked.body.sudoUntil)).toBeGreaterThan(Date.now() + 14 * 60_000);

    await end({ ...others, signal: 'TERM' }).expect(204);
    expect(await gone(others.pid)).toBe(true);
    const events = JSON.stringify(
      await prisma.auditEvent.findMany({ where: { action: { startsWith: 'linux.sudo' } } }),
    );
    expect(events).toContain('sudo_password_wrong');
    expect(events).not.toContain(ANNA.password);
  });

  it('“Lock now” locks sudo and ends the Linux session', async () => {
    await signInAs(ANNA);
    await unlock(ANNA.password).expect(200);
    await request(client.session!.origin)
      .delete('/api/files/session/sudo')
      .set('Origin', client.session!.origin)
      .set('Cookie', client.session!.cookie)
      .expect(204);
    expect(await linuxSession()).toBeNull();

    // A new session's terminal never has the old one's sudo.
    const others = await sleeperOf(BOB);
    await signInAs(ANNA);
    const locked = await end({ ...others, signal: 'TERM' });
    expect([locked.status, locked.body.code]).toEqual([403, 'sudo_required']);
  });

  it('an account without sudo: "not allowed"', async () => {
    await signInAs(BOB);
    const res = await unlock(BOB.password);
    expect([res.status, res.body.code]).toEqual([403, 'sudo_not_allowed']);
  });

  it('refuses a stale start time, PID 1 and bad requests — nothing run', async () => {
    const own = await sleeperOf(ANNA);
    await signInAs(ANNA);
    const stale = String(Number(own.startTicks) + 1);
    const notFound = await end({ pid: own.pid, startTicks: stale, signal: 'TERM' }).expect(404);
    expect(notFound.body.code).toBe('process_not_found');
    const init = await end({ pid: 1, startTicks: startTicks(1), signal: 'KILL' }).expect(403);
    expect(init.body.code).toBe('process_protected');
    await end({ ...own, signal: 'HUP' }).expect(400);
    await end({ pid: -1, startTicks: '1', signal: 'TERM' }).expect(400);
    await end({ ...own, signal: 'TERM', uid: 0 }).expect(400);
    await end({ ...own, signal: 'TERM', password: ANNA.password }).expect(400);
    await unlock('a\nb').expect(400);
    expect(running(own.pid)).toBe(true);
    expect(await audit()).toHaveLength(0);
  });

  it('needs an app session', async () => {
    await request(client.session!.origin)
      .post('/api/processes/signal')
      .set('Origin', client.session!.origin)
      .send({ pid: process.pid, startTicks: startTicks(process.pid), signal: 'TERM' })
      .expect(401);
  });
});
