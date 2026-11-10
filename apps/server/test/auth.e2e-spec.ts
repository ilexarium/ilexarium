import { PasswordHasher } from '@nestjs/authentication';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  apiErrorResponseSchema,
  authStatusResponseSchema,
  meResponseSchema,
  userResponseSchema,
} from '@ilex/shared';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { UsersService } from '../src/users/users.service.js';
import { resetDatabase } from './database.js';

const HOST = 'ilex.test';
const SAME_ORIGIN = `http://${HOST}`;
const PASSWORD = 'correct horse battery';
const NEW_PASSWORD = 'staple battery horse correct';
/** Cheap scrypt for tests (the package documents this); production uses N=2^17. */
const testHasher = new PasswordHasher({ logN: 11 });

describe('auth endpoints (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let users: UsersService;
  /** Every response body seen, to check none ever carries a password hash. */
  const bodies: string[] = [];

  const http = () => request(app.getHttpServer());
  const get = (path: string, cookie?: string) => {
    const req = http().get(`/api${path}`).set('Host', HOST);
    return cookie ? req.set('Cookie', cookie) : req;
  };
  const post = (path: string, body?: object, { cookie = '', origin = SAME_ORIGIN } = {}) => {
    const req = http().post(`/api${path}`).set('Host', HOST).set('Origin', origin);
    if (cookie) req.set('Cookie', cookie);
    return body ? req.send(body) : req;
  };
  const sessionCookie = (res: request.Response): string | undefined =>
    ([] as string[])
      .concat(res.headers['set-cookie'] ?? [])
      .find((cookie) => cookie.startsWith('__Host-sid=') && !cookie.startsWith('__Host-sid=;'))
      ?.split(';')[0];
  const track = (res: request.Response) => {
    bodies.push(JSON.stringify(res.body ?? ''));
    return res;
  };

  async function createOwner(passwordHash?: string) {
    return users.create({
      username: 'owner',
      passwordHash: passwordHash ?? (await testHasher.hash(PASSWORD)),
    });
  }

  async function login(username = 'owner', password = PASSWORD) {
    return track(await post('/auth/login', { username, password }));
  }

  async function loginCookie(): Promise<string> {
    const res = await login();
    expect(res.status).toBe(200);
    return sessionCookie(res)!;
  }

  beforeEach(async () => {
    // A fresh app per test: clean per-IP and per-username throttling state.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PasswordHasher)
      .useValue(testHasher)
      .compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
    prisma = app.get(PrismaService);
    users = app.get(UsersService);
    await resetDatabase(prisma);
  });

  afterEach(() => app.close());

  afterAll(() => {
    for (const body of bodies) expect(body).not.toMatch(/scrypt|passwordHash/);
  });

  describe('GET /auth/status', () => {
    it('reports needsSetup until a user exists', async () => {
      const before = track(await get('/auth/status').expect(200));
      expect(authStatusResponseSchema.parse(before.body)).toEqual({ needsSetup: true });
      await createOwner();
      expect((await get('/auth/status').expect(200)).body).toEqual({ needsSetup: false });
    });
  });

  describe('POST /auth/login', () => {
    it('signs in: returns the public user and sets the session cookie', async () => {
      const { id } = await createOwner();
      const res = await login(' Owner ');
      expect(res.status).toBe(200);
      expect(userResponseSchema.strict().parse(res.body).user).toMatchObject({
        id,
        username: 'owner',
      });
      const cookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []).join(';');
      for (const attribute of [/__Host-sid=/, /HttpOnly/i, /Secure/i, /SameSite=Lax/i]) {
        expect(cookie).toMatch(attribute);
      }
    });

    it('answers a wrong password and an unknown user identically (401 invalid_credentials)', async () => {
      await createOwner();
      const wrong = await login('owner', 'not the password');
      const unknown = await login('nobody', 'not the password');
      for (const res of [wrong, unknown]) {
        expect(res.status).toBe(401);
        expect(apiErrorResponseSchema.parse(res.body)).toEqual({
          message: 'Invalid username or password',
          code: 'invalid_credentials',
        });
        expect(sessionCookie(res)).toBeUndefined();
      }
    });

    it('accepts a password shorter than the current minimum (rules apply only when choosing)', async () => {
      await createOwner(await testHasher.hash('short'));
      expect((await login('owner', 'short')).status).toBe(200);
    });

    it('rejects unknown fields with 400', async () => {
      const res = track(await post('/auth/login', { username: 'owner', password: 'x', admin: 1 }));
      expect(res.status).toBe(400);
      expect(res.body.errors[0]).toMatchObject({ code: 'unrecognized_keys' });
    });

    it('delays the same username after a failure: 429, Retry-After, too_many_attempts', async () => {
      await createOwner();
      expect((await login('owner', 'wrong')).status).toBe(401);
      const res = await login(); // correct password, but inside the delay
      expect(res.status).toBe(429);
      expect(res.headers['retry-after']).toBe('1');
      expect(res.body).toMatchObject({ code: 'too_many_attempts' });
    });

    it('limits login attempts per IP (10 per minute)', async () => {
      for (let i = 0; i < 10; i++) {
        expect((await login(`user-${i}`, 'wrong')).status).toBe(401);
      }
      const res = await login('user-10', 'wrong');
      expect(res.status).toBe(429);
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('re-hashes a password stored with outdated parameters, on success only', async () => {
      const outdated = await new PasswordHasher({ logN: 10 }).hash(PASSWORD);
      await createOwner(outdated);
      await login('owner', 'wrong');
      expect((await users.findCredentials('owner'))?.passwordHash).toBe(outdated);
      await new Promise((resolve) => setTimeout(resolve, 1_000)); // wait out the 1 s delay
      expect((await login()).status).toBe(200);
      const upgraded = (await users.findCredentials('owner'))!.passwordHash;
      expect(upgraded).not.toBe(outdated);
      expect(testHasher.needsRehash(upgraded)).toBe(false);
    });

    it('refuses a sign-in posted from another origin (login CSRF)', async () => {
      await createOwner();
      const res = await post(
        '/auth/login',
        { username: 'owner', password: PASSWORD },
        {
          origin: 'https://evil.example',
        },
      );
      expect(res.status).toBe(403);
      expect(sessionCookie(res)).toBeUndefined();
    });

    it('audits failures (with reason) and successes', async () => {
      await createOwner();
      await login('owner', 'wrong');
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await login();
      await vi.waitFor(async () => expect(await prisma.auditEvent.count()).toBe(2));
      const events = await prisma.auditEvent.findMany({ orderBy: { at: 'asc' } });
      expect(events.map((e) => [e.action, e.outcome, e.username, e.details])).toEqual([
        ['auth.login', 'failure', 'owner', { reason: 'invalid_credentials' }],
        ['auth.login', 'success', 'owner', { method: 'password' }],
      ]);
      expect(JSON.stringify(events)).not.toContain(PASSWORD);
    });
  });

  describe('GET /auth/me', () => {
    it('returns { user: null } when signed out or with a bad cookie — never 401', async () => {
      for (const cookie of [undefined, '__Host-sid=garbage']) {
        const res = track(await get('/auth/me', cookie));
        expect(res.status).toBe(200);
        expect(meResponseSchema.parse(res.body)).toEqual({ user: null });
      }
    });

    it('returns the signed-in user', async () => {
      await createOwner();
      const res = track(await get('/auth/me', await loginCookie()).expect(200));
      expect(res.body.user.username).toBe('owner');
    });

    it('returns null once the user is deleted', async () => {
      const { id } = await createOwner();
      const cookie = await loginCookie();
      await prisma.user.delete({ where: { id } });
      expect((await get('/auth/me', cookie).expect(200)).body).toEqual({ user: null });
    });
  });

  describe('POST /auth/logout', () => {
    it('ends the session immediately and is idempotent', async () => {
      await createOwner();
      const cookie = await loginCookie();
      await post('/auth/logout', undefined, { cookie }).expect(204);
      expect((await get('/auth/me', cookie)).body).toEqual({ user: null });
      expect(await prisma.session.count()).toBe(0);
      await post('/auth/logout', undefined, { cookie }).expect(204);
      await post('/auth/logout').expect(204);
    });
  });

  describe('POST /auth/password', () => {
    const change = (cookie: string, body: object, origin?: string) =>
      post('/auth/password', body, { cookie, origin });

    it('requires a session', async () => {
      const res = await post('/auth/password', {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      });
      expect(res.status).toBe(401);
    });

    it('rejects a wrong current password with 400 on currentPassword — never 401', async () => {
      await createOwner();
      const cookie = await loginCookie();
      const res = track(
        await change(cookie, { currentPassword: 'wrong', newPassword: NEW_PASSWORD }),
      );
      expect(res.status).toBe(400);
      expect(res.body.errors).toEqual([
        {
          field: 'currentPassword',
          code: 'wrong_password',
          message: 'Current password is incorrect',
        },
      ]);
      expect((await get('/auth/me', cookie)).body.user).not.toBeNull(); // still signed in
    });

    it('applies the choosing rules to the new password', async () => {
      await createOwner();
      const res = await change(await loginCookie(), {
        currentPassword: PASSWORD,
        newPassword: 'short',
      });
      expect(res.status).toBe(400);
      expect(res.body.errors[0]).toMatchObject({ field: 'newPassword', code: 'too_small' });
    });

    it('changes the password, keeps this browser signed in, signs out every other session', async () => {
      await createOwner();
      const other = await loginCookie();
      const mine = await loginCookie();
      const res = await change(mine, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
      expect(res.status).toBe(204);

      const rotated = sessionCookie(res);
      expect(rotated).toBeDefined();
      expect(rotated).not.toBe(mine);
      expect((await get('/auth/me', rotated)).body.user.username).toBe('owner');
      expect((await get('/auth/me', mine)).body).toEqual({ user: null }); // old id gone
      expect((await get('/auth/me', other)).body).toEqual({ user: null }); // other device
      expect(await prisma.session.count()).toBe(1);

      expect((await login('owner', NEW_PASSWORD)).status).toBe(200);
      await vi.waitFor(async () =>
        expect(
          await prisma.auditEvent.count({
            where: { action: 'auth.password_change', outcome: 'success' },
          }),
        ).toBe(1),
      );
    });

    it('refuses a cross-origin change even with a valid cookie (CSRF)', async () => {
      await createOwner();
      const res = await change(
        await loginCookie(),
        { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
        'https://evil.example',
      );
      expect(res.status).toBe(403);
      expect((await login('owner', PASSWORD)).status).toBe(200); // unchanged
    });
  });

  it('stores only the SHA-256 of the session token', async () => {
    await createOwner();
    const token = (await loginCookie()).split('=')[1];
    const [session] = await prisma.session.findMany();
    expect(session.id).not.toContain(token);
  });
});
