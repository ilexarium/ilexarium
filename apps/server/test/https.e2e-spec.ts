import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PasswordHasher } from '@nestjs/authentication';
import { Test } from '@nestjs/testing';
import { REALTIME_PATH, TERMINAL_PATH } from '@ilex/shared';
import request from 'supertest';
import { WebSocket } from 'ws';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { readCertificate } from '../src/common/https-certificate.js';
import { listenOnSockets } from '../src/common/systemd-socket.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { UsersService } from '../src/users/users.service.js';
import { resetDatabase } from './database.js';
import { Client, testHasher } from './realtime-client.js';

// The app as production runs it with HTTPS on the network: the plain socket for a proxy, and an
// HTTPS one (ilex-https.socket) whose connections are decrypted and handed to the same server —
// sign-in, the realtime socket and the terminal all over it. The certificate is the test one
// (test/fixtures/tls: localhost, 127.0.0.1), trusted only by these requests.

const PASSWORD = 'correct horse battery staple';
const ANNA = { username: 'anna', password: 'anna-dev-password' };
const CERT_FILE = new URL('fixtures/tls/cert.pem', import.meta.url).pathname;
const KEY_FILE = new URL('fixtures/tls/key.pem', import.meta.url).pathname;
const ca = readFileSync(CERT_FILE);

const sshdUp = await new Promise<boolean>((done) => {
  const socket = connect(2222, '127.0.0.1');
  socket.once('connect', () => (socket.destroy(), done(true)));
  socket.once('error', () => done(false));
});

describe('HTTPS on the network (e2e)', { timeout: 20_000 }, () => {
  let app: NestExpressApplication;
  let origin: string;
  let plainOrigin: string;

  const post = (path: string, body: object, cookie = '') => {
    const req = request(origin).post(`/api${path}`).ca(ca).set('Origin', origin);
    return (cookie ? req.set('Cookie', cookie) : req).send(body);
  };

  async function signIn(): Promise<string> {
    const login = await post('/auth/login', { username: 'owner', password: PASSWORD }).expect(200);
    const cookie = ([] as string[])
      .concat(login.headers['set-cookie'] ?? [])
      .find((c) => c.startsWith('__Host-sid='))!;
    expect(cookie).toMatch(/; Secure/i);
    return cookie.split(';')[0]!;
  }

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PasswordHasher)
      .useValue(testHasher)
      .compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
    const local = { port: 0, host: '127.0.0.1' };
    const listening = await listenOnSockets(
      app.getHttpServer(),
      [local],
      [local],
      await readCertificate(CERT_FILE, KEY_FILE),
    );
    origin = `https://localhost:${listening.encrypted[0]!.port}`;
    plainOrigin = `http://127.0.0.1:${listening.plain[0]!.port}`;
    await resetDatabase(app.get(PrismaService));
    await app
      .get(UsersService)
      .create({ username: 'owner', passwordHash: await testHasher.hash(PASSWORD) });
  }, 60_000);

  afterEach(async () => {
    await app?.close();
  });

  it('answers over HTTPS and over the plain socket alike', async () => {
    const https = await request(origin).get('/api/health').ca(ca).expect(200);
    const plain = await request(plainOrigin).get('/api/health').expect(200);
    expect(https.body).toEqual(plain.body);
  });

  it('signs in with a Secure session cookie that works for the API', async () => {
    const cookie = await signIn();
    const me = await request(origin).get('/api/auth/me').ca(ca).set('Cookie', cookie).expect(200);
    expect(me.body.user.username).toBe('owner');
  });

  it('refuses a sign-in from another site, as over the proxy', async () => {
    await request(origin)
      .post('/api/auth/login')
      .ca(ca)
      .set('Origin', 'https://evil.example')
      .send({ username: 'owner', password: PASSWORD })
      .expect(403);
  });

  it('the realtime socket over the HTTPS port: admitted and answering', async () => {
    const cookie = await signIn();
    const client = new Client(
      new WebSocket(`${origin.replace('https:', 'wss:')}${REALTIME_PATH}`, {
        headers: { Cookie: cookie },
        origin,
        ca,
      }),
    );
    await new Promise((resolve, reject) => {
      client.socket.once('open', resolve);
      client.socket.once('error', reject);
    });
    await client.flush();
    client.socket.close();
  });

  it.skipIf(!sshdUp)('the terminal over the HTTPS port', async () => {
    const cookie = await signIn();
    await post('/files/session', ANNA, cookie).expect(200);
    const { ticket } = (await post('/terminal/ticket', { password: PASSWORD }, cookie).expect(200))
      .body as { ticket: string };
    const socket = new WebSocket(
      `${origin.replace('https:', 'wss:')}${TERMINAL_PATH}?ticket=${ticket}&cols=80&rows=24`,
      { headers: { Cookie: cookie }, origin, ca },
    );
    let output = '';
    socket.on('message', (data: Buffer) => (output += data.toString('utf8')));
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.send(Buffer.from('echo "over tls: $((40 + 2))"\n'), { binary: true });
    await vi.waitFor(() => expect(output).toMatch(/over tls: 42/), { timeout: 5000 });
    socket.close();
  });
});
