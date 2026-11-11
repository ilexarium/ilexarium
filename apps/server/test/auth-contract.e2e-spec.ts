import { PasswordHasher } from '@nestjs/authentication';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  apiErrorResponseSchema,
  authStatusResponseSchema,
  meResponseSchema,
  userResponseSchema,
} from '@ilex/shared';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { resetDatabaseBeforeStart } from './database.js';

/**
 * The server's auth contract as the web app relies on it: one complete
 * journey, the status-code table, default deny across every route, and no password hash in any
 * response.
 */

const HOST = 'ilex.test';
const SAME_ORIGIN = `http://${HOST}`;
const PASSWORD = 'correct horse battery';
const NEW_PASSWORD = 'staple battery horse correct';

/**
 * Routes that may answer without a session. Anything else must be 401 without one. Adding a
 * route here is a deliberate, reviewable decision.
 */
const ROUTES_WITHOUT_SESSION = new Set([
  'GET /api/health',
  'GET /api/auth/status',
  'POST /api/auth/setup',
  'POST /api/auth/login',
  'POST /api/auth/logout',
  'GET /api/auth/me', // optional: { user: null }
]);

let app: NestExpressApplication;
/** Every response body seen in this file. */
const bodies: string[] = [];

const http = () => request(app.getHttpServer());

async function send(
  method: 'get' | 'post' | 'put' | 'patch' | 'delete',
  path: string,
  { body, cookie }: { body?: object; cookie?: string } = {},
) {
  const req = http()[method](path).set('Host', HOST).set('Origin', SAME_ORIGIN);
  if (cookie) req.set('Cookie', cookie);
  const res = await (body ? req.send(body) : req);
  bodies.push(JSON.stringify(res.body ?? ''));
  return res;
}

const sessionCookie = (res: request.Response) =>
  ([] as string[])
    .concat(res.headers['set-cookie'] ?? [])
    .find((c) => c.startsWith('__Host-sid=') && !c.startsWith('__Host-sid=;'))
    ?.split(';')[0];

/** Every route Express knows about, as "METHOD /path". */
function registeredRoutes(): string[] {
  const express = app.getHttpAdapter().getInstance();
  // Express's types omit `route.methods`, which exists at runtime.
  const stack = express.router.stack as unknown as {
    route?: { path: string; methods: Record<string, boolean> };
  }[];
  return stack.flatMap((layer) =>
    layer.route
      ? Object.keys(layer.route.methods).map(
          (method) => `${method.toUpperCase()} ${layer.route!.path}`,
        )
      : [],
  );
}

beforeEach(async () => {
  await resetDatabaseBeforeStart();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PasswordHasher)
    .useValue(new PasswordHasher({ logN: 11 }))
    .compile();
  app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
  await app.init();
});

afterEach(() => app.close());

afterAll(() => {
  expect(bodies.length).toBeGreaterThan(0);
  for (const body of bodies) expect(body).not.toMatch(/scrypt|passwordHash/);
});

describe('auth contract (e2e)', () => {
  it('a complete journey: setup → me → logout → login → change password → login', async () => {
    expect(authStatusResponseSchema.parse((await send('get', '/api/auth/status')).body)).toEqual({
      needsSetup: true,
    });
    expect(meResponseSchema.parse((await send('get', '/api/auth/me')).body)).toEqual({
      user: null,
    });

    const setupToken = (await readFile(resolve(process.env.SETUP_TOKEN_FILE!), 'utf8')).trim();
    const setup = await send('post', '/api/auth/setup', {
      body: { setupToken, username: 'owner', password: PASSWORD },
    });
    expect(setup.status).toBe(200);
    const owner = userResponseSchema.parse(setup.body).user;
    let cookie = sessionCookie(setup)!;

    expect((await send('get', '/api/auth/me', { cookie })).body).toEqual({ user: owner });
    expect((await send('get', '/api/auth/status')).body).toEqual({ needsSetup: false });

    expect((await send('post', '/api/auth/logout', { cookie })).status).toBe(204);
    expect((await send('get', '/api/auth/me', { cookie })).body).toEqual({ user: null });

    const login = await send('post', '/api/auth/login', {
      body: { username: 'owner', password: PASSWORD },
    });
    expect(login.status).toBe(200);
    expect(login.body).toEqual({ user: owner });
    cookie = sessionCookie(login)!;

    const change = await send('post', '/api/auth/password', {
      cookie,
      body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect(change.status).toBe(204);
    cookie = sessionCookie(change)!;
    expect((await send('get', '/api/auth/me', { cookie })).body).toEqual({ user: owner });

    expect(
      (await send('post', '/api/auth/login', { body: { username: 'owner', password: PASSWORD } }))
        .status,
    ).toBe(401);
    await new Promise((resolve) => setTimeout(resolve, 1_000)); // per-username delay
    expect(
      (
        await send('post', '/api/auth/login', {
          body: { username: 'owner', password: NEW_PASSWORD },
        })
      ).status,
    ).toBe(200);
  });

  describe('status-code table', () => {
    async function ownerCookie(): Promise<string> {
      const setupToken = (await readFile(resolve(process.env.SETUP_TOKEN_FILE!), 'utf8')).trim();
      const res = await send('post', '/api/auth/setup', {
        body: { setupToken, username: 'owner', password: PASSWORD },
      });
      return sessionCookie(res)!;
    }

    it('wrong username/password at login → 401 invalid_credentials', async () => {
      await ownerCookie();
      const res = await send('post', '/api/auth/login', {
        body: { username: 'owner', password: 'wrong' },
      });
      expect(res.status).toBe(401);
      expect(apiErrorResponseSchema.parse(res.body).code).toBe('invalid_credentials');
    });

    it('wrong setup token → 403', async () => {
      const res = await send('post', '/api/auth/setup', {
        body: { setupToken: 'WRONG', username: 'owner', password: PASSWORD },
      });
      expect(res.status).toBe(403);
      expect(apiErrorResponseSchema.parse(res.body).code).toBe('invalid_setup_token');
    });

    it('wrong current password on change → 400 on currentPassword, never 401', async () => {
      const cookie = await ownerCookie();
      const res = await send('post', '/api/auth/password', {
        cookie,
        body: { currentPassword: 'wrong', newPassword: NEW_PASSWORD },
      });
      expect(res.status).toBe(400);
      expect(apiErrorResponseSchema.parse(res.body).errors?.[0]).toMatchObject({
        field: 'currentPassword',
        code: 'wrong_password',
      });
    });

    it('invalid input → 400 with field errors', async () => {
      const res = await send('post', '/api/auth/login', { body: { username: '' } });
      expect(res.status).toBe(400);
      const fields = apiErrorResponseSchema.parse(res.body).errors?.map((e) => e.field);
      expect(fields).toEqual(expect.arrayContaining(['username', 'password']));
    });

    it('too many attempts → 429 + Retry-After', async () => {
      await ownerCookie();
      await send('post', '/api/auth/login', { body: { username: 'owner', password: 'wrong' } });
      const res = await send('post', '/api/auth/login', {
        body: { username: 'owner', password: 'wrong' },
      });
      expect(res.status).toBe(429);
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      expect(apiErrorResponseSchema.parse(res.body).code).toBe('too_many_attempts');
    });

    it('any other 401 means the session is missing or ended', async () => {
      const cookie = await ownerCookie();
      await send('post', '/api/auth/logout', { cookie });
      const res = await send('post', '/api/auth/password', {
        cookie,
        body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      });
      expect(res.status).toBe(401);
    });
  });

  describe('default deny', () => {
    it('finds the routes it checks', () => {
      const routes = registeredRoutes();
      expect(routes).toContain('POST /api/auth/password');
      for (const route of ROUTES_WITHOUT_SESSION) expect(routes).toContain(route);
    });

    it('every route not explicitly listed answers 401 without a session', async () => {
      const unexpected: string[] = [];
      for (const route of registeredRoutes()) {
        const [method, path] = route.split(' ');
        const res = await send(
          method.toLowerCase() as 'get',
          path.replace(/:[^/]+/g, 'probe'), // fill route parameters
          { body: {} },
        );
        const allowed = ROUTES_WITHOUT_SESSION.has(route);
        if (!allowed && res.status !== 401) unexpected.push(`${route} → ${res.status}`);
      }
      expect(unexpected).toEqual([]);
    });
  });
});
