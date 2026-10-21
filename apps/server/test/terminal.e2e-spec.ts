import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { PasswordHasher } from '@nestjs/authentication';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { TERMINAL_CLOSE_CODES, TERMINAL_PATH } from '@laris/shared';
import request from 'supertest';
import { WebSocket } from 'ws';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { UsersService } from '../src/users/users.service.js';
import { resetDatabase } from './database.js';
import { testHasher } from './realtime-client.js';

// The web terminal end to end, against the development SSH server (dev/sshd, user anna).
// Skipped when it isn't running (npm run db:up starts it). A fresh app per test: the ticket
// endpoint allows 5 tries a minute per address.

const PASSWORD = 'correct horse battery staple';
const ANNA = { username: 'anna', password: 'anna-dev-password' };

const sshdUp = await new Promise<boolean>((done) => {
  const socket = connect(2222, '127.0.0.1');
  socket.once('connect', () => (socket.destroy(), done(true)));
  socket.once('error', () => done(false));
});

/** A terminal socket: everything it showed, and how it closed. */
class Terminal {
  output = '';
  readonly opened: Promise<void>;
  readonly closed: Promise<{ code: number; reason: string }>;
  constructor(readonly socket: WebSocket) {
    socket.on('message', (data: Buffer) => (this.output += data.toString('utf8')));
    this.opened = new Promise((ok) => socket.once('open', () => ok()));
    socket.on('error', (error) => (this.output += `[error ${error.message}]`));
    this.closed = new Promise((ok) =>
      socket.once('close', (code, reason) => ok({ code, reason: reason.toString() })),
    );
  }
  type(text: string): void {
    this.socket.send(Buffer.from(text), { binary: true });
  }
  async shows(pattern: RegExp, timeoutMs = 5000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (!pattern.test(this.output)) {
      if (Date.now() > until)
        throw new Error(`Not shown: ${pattern} in ${JSON.stringify(this.output)}`);
      await new Promise((ok) => setTimeout(ok, 50));
    }
  }
}

describe.skipIf(!sshdUp)('terminal (e2e)', { timeout: 20_000 }, () => {
  let app: NestExpressApplication;
  let origin: string;
  let cookie: string;
  let prisma: PrismaService;

  const post = (path: string, body: object = {}) =>
    request(origin).post(`/api${path}`).set('Origin', origin).set('Cookie', cookie).send(body);
  const ticket = async () =>
    (
      (await post('/terminal/ticket', { password: PASSWORD }).expect(200)).body as {
        ticket: string;
      }
    ).ticket;
  const open = (
    query: string,
    headers: Record<string, string> = { Origin: origin, Cookie: cookie },
  ) =>
    new Terminal(
      new WebSocket(`${origin.replace('http', 'ws')}${TERMINAL_PATH}?${query}`, { headers }),
    );
  const openWith = (value: string) => open(`ticket=${value}&cols=80&rows=24`);

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PasswordHasher)
      .useValue(testHasher)
      .compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.listen(0, '127.0.0.1');
    origin = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);
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
  }, 60_000);

  afterEach(async () => {
    await app?.close();
  });

  it('a ticket needs a Linux session and the app password again', async () => {
    const noLinux = await post('/terminal/ticket', { password: PASSWORD }).expect(403);
    expect(noLinux.body.code).toBe('linux_session_required');
    await post('/files/session', ANNA).expect(200);
    const wrong = await post('/terminal/ticket', { password: 'not it' }).expect(400);
    expect(wrong.body.errors).toMatchObject([{ field: 'password', code: 'wrong_password' }]);
  });

  it('opens a shell as anna: typing, resizing, exit — audited, never what was typed', async () => {
    await post('/files/session', ANNA).expect(200);
    const terminal = openWith(await ticket());
    await terminal.opened;
    terminal.type('echo "result: $((40 + 2)) as $(whoami)"\n');
    await terminal.shows(/result: 42 as anna/);
    terminal.socket.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
    terminal.type('stty size\n');
    await terminal.shows(/30 100/);
    terminal.type('exit\n');
    expect((await terminal.closed).code).toBe(TERMINAL_CLOSE_CODES.exited);

    await vi.waitFor(async () => {
      const audit = await prisma.auditEvent.findMany({
        where: { action: { in: ['terminal.open', 'terminal.close'] } },
        orderBy: { at: 'asc' },
      });
      expect(audit.map((a) => [a.action, a.details])).toEqual([
        ['terminal.open', { linuxUser: 'anna' }],
        ['terminal.close', { linuxUser: 'anna', reason: 'exited' }],
      ]);
    });
    const everything = JSON.stringify(await prisma.auditEvent.findMany());
    expect(everything).not.toContain('whoami');
    expect(everything).not.toContain('anna-dev-password');
  });

  it('refuses: another origin, no session, no ticket, a used ticket', async () => {
    await post('/files/session', ANNA).expect(200);
    const value = await ticket();
    const foreign = open(`ticket=${value}&cols=80&rows=24`, {
      Origin: 'https://evil.example',
      Cookie: cookie,
    });
    expect((await foreign.closed).code).toBe(1008);
    const anonymous = open(`ticket=${value}&cols=80&rows=24`, { Origin: origin });
    expect((await anonymous.closed).code).toBe(TERMINAL_CLOSE_CODES.sessionEnded);
    expect((await open('cols=80&rows=24').closed).code).toBe(1008);
    expect((await openWith('made-up').closed).code).toBe(TERMINAL_CLOSE_CODES.ticketRefused);

    const first = openWith(value);
    await first.opened;
    await first.shows(/\$ $/m);
    expect((await openWith(value).closed).code).toBe(TERMINAL_CLOSE_CODES.ticketRefused);
    first.socket.close();
  });

  it('a second terminal replaces the first; a bad control message closes it', async () => {
    await post('/files/session', ANNA).expect(200);
    const first = openWith(await ticket());
    await first.opened;
    const second = openWith(await ticket());
    await second.opened;
    expect((await first.closed).code).toBe(TERMINAL_CLOSE_CODES.replaced);
    second.socket.send(JSON.stringify({ type: 'run', command: 'reboot' }));
    expect((await second.closed).code).toBe(1008);
  });

  it('closes with the Linux session (4003) and at the app’s sign-out (4401)', async () => {
    await post('/files/session', ANNA).expect(200);
    const first = openWith(await ticket());
    await first.shows(/\$ $/m); // admitted: the shell's prompt
    await request(origin)
      .delete('/api/files/session')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .expect(204);
    expect((await first.closed).code).toBe(TERMINAL_CLOSE_CODES.linuxSessionEnded);

    await post('/files/session', ANNA).expect(200);
    const second = openWith(await ticket());
    await second.shows(/\$ $/m);
    await post('/auth/logout').expect(204);
    expect((await second.closed).code).toBe(TERMINAL_CLOSE_CODES.sessionEnded);
  });
});
