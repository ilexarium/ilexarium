import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { PasswordHasher } from '@nestjs/authentication';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { meResponseSchema, PROFILE_LIMITS, userResponseSchema } from '@homelab/shared';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { type SignedIn, signIn, testHasher } from './realtime-client.js';

const picture = (name: string) =>
  readFileSync(new URL(`../src/profile/testdata/${name}`, import.meta.url));

describe('profile (e2e)', () => {
  let app: NestExpressApplication;
  let session: SignedIn;

  const call = (
    method: 'get' | 'patch' | 'put' | 'delete' | 'post',
    path: string,
    cookie = session.cookie,
  ) =>
    request(session.origin)
      [method](`/api${path}`)
      .set('Origin', session.origin)
      .set('Cookie', cookie);
  const me = async (cookie = session.cookie) =>
    meResponseSchema.parse((await call('get', '/auth/me', cookie).expect(200)).body).user;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PasswordHasher)
      .useValue(testHasher)
      .compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    session = await signIn(app);
  });

  afterEach(() => app.close());

  it('needs a session on every route', async () => {
    const anonymous = (method: 'get' | 'patch' | 'put' | 'delete' | 'post', path: string) =>
      request(session.origin)[method](`/api${path}`).set('Origin', session.origin);
    await anonymous('patch', '/profile').send({ displayName: 'x' }).expect(401);
    await anonymous('put', '/profile/avatar').send(picture('canvas-600.webp')).expect(401);
    await anonymous('delete', '/profile/avatar').expect(401);
    await anonymous('get', '/profile/avatar').expect(401);
    await anonymous('post', '/auth/logout-everywhere').expect(401);
  });

  it('starts empty, saves a name, an address and a language, and me shows them', async () => {
    expect(await me()).toMatchObject({
      displayName: null,
      email: null,
      language: null,
      avatar: null,
    });
    const saved = await call('patch', '/profile')
      .send({ displayName: ' Anna Berg ', email: 'anna@example.com', language: 'ar' })
      .expect(200);
    expect(userResponseSchema.parse(saved.body).user).toMatchObject({
      displayName: 'Anna Berg',
      email: 'anna@example.com',
      language: 'ar',
    });
    expect(await me()).toMatchObject({ displayName: 'Anna Berg', language: 'ar' });

    await call('patch', '/profile').send({ displayName: '', email: '' }).expect(200);
    expect(await me()).toMatchObject({ displayName: null, email: null, language: 'ar' });
  });

  it('audits the changed fields without their values', async () => {
    await call('patch', '/profile').send({ email: 'anna@example.com' }).expect(200);
    const [entry] = await app.get(PrismaService).auditEvent.findMany({
      where: { action: 'profile.update' },
    });
    expect(entry.details).toEqual({ fields: ['email'] });
  });

  it('refuses invalid changes with 400', async () => {
    for (const body of [
      {},
      { email: 'not-an-address' },
      { language: 'fr' },
      { displayName: 'x'.repeat(PROFILE_LIMITS.displayNameMax + 1) },
      { username: 'root' },
      { avatar: '/etc/passwd' },
    ]) {
      await call('patch', '/profile').send(body).expect(400);
    }
    expect(await me()).toMatchObject({ username: 'owner', displayName: null, avatar: null });
  });

  it('keeps a picture, serves it only as that image, and removes it', async () => {
    const bytes = picture('canvas-600.webp');
    const saved = await call('put', '/profile/avatar')
      .set('Content-Type', 'image/png') // what the browser says doesn't count
      .send(bytes)
      .expect(200);
    const path = userResponseSchema.parse(saved.body).user.avatar!;
    expect(path).toMatch(/^\/api\/profile\/avatar\?v=\d+$/);
    expect((await me())?.avatar).toBe(path);

    const served = await request(session.origin)
      .get(path)
      .set('Cookie', session.cookie)
      .expect(200);
    expect(Buffer.compare(served.body as Buffer, bytes)).toBe(0);
    expect(served.headers['content-type']).toBe('image/webp');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(served.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(served.headers['cache-control']).toBe('private, max-age=31536000, immutable');

    // An old or missing version: served, but not to be kept.
    const old = await call('get', '/profile/avatar?v=1').expect(200);
    expect(old.headers['cache-control']).toBe('private, no-cache');
    await call('get', '/profile/avatar?v=abc').expect(400);

    const removed = await call('delete', '/profile/avatar').expect(200);
    expect(userResponseSchema.parse(removed.body).user.avatar).toBeNull();
    await call('get', '/profile/avatar').expect(404);
  });

  it('takes a JPEG or PNG too', async () => {
    for (const [name, type] of [
      ['canvas-600.jpg', 'image/jpeg'],
      ['canvas-600.png', 'image/png'],
    ]) {
      await call('put', '/profile/avatar')
        .set('Content-Type', 'application/octet-stream')
        .send(picture(name))
        .expect(200);
      const served = await call('get', '/profile/avatar').expect(200);
      expect(served.headers['content-type'], name).toBe(type);
    }
  });

  it('refuses a picture of the wrong size or kind (400), or too large (413)', async () => {
    const put = (body: Buffer, type = 'image/webp') =>
      call('put', '/profile/avatar').set('Content-Type', type).send(body);
    for (const bytes of [
      picture('canvas-599x600.webp'),
      picture('red-600.gif'),
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"/>'),
      Buffer.from('<!doctype html><script>alert(1)</script>'),
    ]) {
      const refused = await put(bytes).expect(400);
      expect(refused.body.code).toBe('invalid_picture');
    }
    const big = Buffer.concat([
      picture('canvas-600.png'),
      Buffer.alloc(PROFILE_LIMITS.pictureMaxBytes),
    ]);
    expect((await put(big).expect(413)).body.code).toBe('picture_too_large');
    expect((await me())?.avatar).toBeNull();
  });

  it('answers 413 to an oversized picture sent in chunks, without a length', async () => {
    const { hostname, port } = new URL(session.origin);
    const answer = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          host: hostname,
          port,
          method: 'PUT',
          path: '/api/profile/avatar',
          headers: { Origin: session.origin, Cookie: session.cookie, 'Content-Type': 'image/webp' },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => resolve({ status: res.statusCode!, body }));
        },
      );
      req.on('error', reject);
      const chunk = Buffer.alloc(64 * 1024);
      for (let sent = 0; sent <= PROFILE_LIMITS.pictureMaxBytes; sent += chunk.length)
        req.write(chunk);
      req.end();
    });
    expect(answer.status).toBe(413);
    expect(JSON.parse(answer.body).code).toBe('picture_too_large');
    expect((await me())?.avatar).toBeNull();
  });

  it('signs out every session of the user, this one too', async () => {
    const second = await request(session.origin)
      .post('/api/auth/login')
      .set('Origin', session.origin)
      .send({ username: 'owner', password: 'correct horse battery' })
      .expect(200);
    const otherCookie = ([] as string[])
      .concat(second.headers['set-cookie'] ?? [])
      .find((c) => c.startsWith('__Host-sid='))!
      .split(';')[0];
    expect(await me(otherCookie)).not.toBeNull();

    await call('post', '/auth/logout-everywhere').expect(204);
    expect(await me()).toBeNull();
    expect(await me(otherCookie)).toBeNull();
  });
});
