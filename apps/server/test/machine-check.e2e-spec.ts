import { connect } from 'node:net';
import { PasswordHasher } from '@nestjs/authentication';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { type Client, connectSignedIn, testHasher } from './realtime-client.js';

// The machine check as anna, through the helper on the development SSH server (dev/sshd): no
// systemd in that container, so no user units there — apps would run as system units. The real
// ones are the install test's (tools/vm/smoke.mjs). Skipped when the SSH server isn't running.

const ANNA = { username: 'anna', password: 'anna-dev-password' };

const sshdUp = await new Promise<boolean>((done) => {
  const socket = connect(2222, '127.0.0.1');
  socket.once('connect', () => (socket.destroy(), done(true)));
  socket.once('error', () => done(false));
});

describe.skipIf(!sshdUp)('machine check (e2e)', () => {
  let app: NestExpressApplication;
  let client: Client;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PasswordHasher)
      .useValue(testHasher)
      .compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    client = await connectSignedIn(app);
  });

  afterEach(async () => {
    client?.socket.terminate();
    await app?.close();
  });

  const post = (path: string, body: object = {}) =>
    request(client.session!.origin)
      .post(`/api${path}`)
      .set('Origin', client.session!.origin)
      .set('Cookie', client.session!.cookie)
      .send(body);

  it('needs a Linux session (403, never 401)', async () => {
    const res = await post('/machine-check/person');
    expect([res.status, res.body.code]).toEqual([403, 'linux_session_required']);
  });

  it('checks the helper as anna, and how her apps would reach Docker', async () => {
    await post('/files/session', ANNA).expect(200);
    const { body } = await post('/machine-check/person').expect(200);
    expect(body).toMatchObject({ helper: 'ok', userUnits: false, docker: 'no_user_units' });
    // Read from this machine's files, where the dev SSH server's anna has no marker.
    expect(body.lingering).toBe(false);
  });

  it('a wrong password is still told apart from password logins turned off', async () => {
    const res = await post('/files/session', { ...ANNA, password: 'nope' });
    expect([res.status, res.body.code]).toEqual([403, 'linux_login_refused']);
  });
});
