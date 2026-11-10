import { PasswordHasher } from '@nestjs/authentication';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { ILEX_VERSION } from '../src/common/ilex-version.js';
import { type Client, connectSignedIn, testHasher } from './realtime-client.js';

// Ilexarium's own updates without an update source (development has no release.env): the status,
// the switch, and the refusals. The update itself is ilex-update's (its spec, the install test).
describe('updates (e2e)', () => {
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

  const call = (method: 'get' | 'post' | 'put', path: string, body?: object) =>
    request(client.session!.origin)
      [method](`/api${path}`)
      .set('Origin', client.session!.origin)
      .set('Cookie', client.session!.cookie)
      .send(body);

  it('says what’s installed, and that this install has no update source', async () => {
    const res = await call('get', '/updates');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      configured: false,
      installed: ILEX_VERSION,
      available: null,
    });
  });

  it('keeps the daily check’s switch', async () => {
    expect((await call('put', '/updates/settings', { checkAutomatically: false })).status).toBe(
      204,
    );
    expect((await call('get', '/updates')).body.checkAutomatically).toBe(false);
    expect((await call('put', '/updates/settings', { checkAutomatically: 'no' })).status).toBe(400);
  });

  it('takes only a version, and starts nothing without an update source', async () => {
    const withUrl = await call('post', '/updates', { version: '9.9.9', url: 'https://elsewhere' });
    expect(withUrl.status).toBe(400);
    expect((await call('post', '/updates', { version: 'latest' })).status).toBe(400);
    const res = await call('post', '/updates', { version: '9.9.9' });
    expect([res.status, res.body.code]).toEqual([409, 'update_not_configured']);
  });
});
