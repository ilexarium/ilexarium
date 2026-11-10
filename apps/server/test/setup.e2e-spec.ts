import { PasswordHasher } from '@nestjs/authentication';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { apiErrorResponseSchema, userResponseSchema } from '@ilex/shared';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { resetDatabaseBeforeStart } from './database.js';

const HOST = 'ilex.test';
const SAME_ORIGIN = `http://${HOST}`;
const PASSWORD = 'correct horse battery';
const tokenFile = resolve(process.env.SETUP_TOKEN_FILE!);

describe('first-run setup (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;

  const http = () => request(app.getHttpServer());
  const setup = (body: object, origin = SAME_ORIGIN) =>
    http().post('/api/auth/setup').set('Host', HOST).set('Origin', origin).send(body);
  const readToken = async () => (await readFile(tokenFile, 'utf8')).trim();
  const tokenFileExists = () =>
    stat(tokenFile).then(
      () => true,
      () => false,
    );

  beforeEach(async () => {
    await resetDatabaseBeforeStart(); // the token is only generated when the app starts empty
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PasswordHasher)
      .useValue(new PasswordHasher({ logN: 11 }))
      .compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterEach(() => app.close());

  it('creates the owner with the setup code, signs in, and closes setup for good', async () => {
    expect((await http().get('/api/auth/status')).body).toEqual({ needsSetup: true });
    const token = await readToken();

    // Typed by hand: lowercase, spaces instead of dashes.
    const typed = token.toLowerCase().replaceAll('-', ' ');
    const res = await setup({ setupToken: typed, username: 'Owner', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(userResponseSchema.strict().parse(res.body).user.username).toBe('owner');
    expect(JSON.stringify(res.body)).not.toMatch(/scrypt|passwordHash/);

    const cookie = ([] as string[])
      .concat(res.headers['set-cookie'] ?? [])
      .find((c) => c.startsWith('__Host-sid='))!
      .split(';')[0];
    const me = await http().get('/api/auth/me').set('Cookie', cookie);
    expect(me.body.user.username).toBe('owner');

    expect((await http().get('/api/auth/status')).body).toEqual({ needsSetup: false });
    expect(await tokenFileExists()).toBe(false);

    const again = await setup({ setupToken: token, username: 'intruder', password: PASSWORD });
    expect(again.status).toBe(403);
    expect(apiErrorResponseSchema.parse(again.body).code).toBe('setup_not_available');
    expect(await prisma.user.count()).toBe(1);
  });

  it('rejects a wrong code with 403 invalid_setup_token, creates nothing, audits it', async () => {
    const res = await setup({
      setupToken: 'AAAA-BBBB-CCCC',
      username: 'intruder',
      password: PASSWORD,
    });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      message: 'This setup code is not valid',
      code: 'invalid_setup_token',
    });
    expect(await prisma.user.count()).toBe(0);
    expect(await tokenFileExists()).toBe(true); // still usable by the real owner
    const [event] = await prisma.auditEvent.findMany();
    expect(event).toMatchObject({
      action: 'auth.setup',
      outcome: 'failure',
      username: 'intruder',
      details: { reason: 'invalid_setup_token' },
    });
  });

  it('lets exactly one of two simultaneous setups succeed', async () => {
    const setupToken = await readToken();
    const results = await Promise.all(
      ['first', 'second', 'third'].map((username) =>
        setup({ setupToken, username, password: PASSWORD }),
      ),
    );
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 403, 403]);
    expect(await prisma.user.count()).toBe(1);
  });

  it('applies the choosing rules to username and password', async () => {
    const setupToken = await readToken();
    const res = await setup({ setupToken, username: 'ab', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.errors.map((e: { field: string }) => e.field).sort()).toEqual([
      'password',
      'username',
    ]);
    expect(await prisma.user.count()).toBe(0);
  });

  it('refuses a setup posted from another origin (CSRF)', async () => {
    const setupToken = await readToken();
    const res = await setup(
      { setupToken, username: 'owner', password: PASSWORD },
      'https://evil.example',
    );
    expect(res.status).toBe(403);
    expect(await prisma.user.count()).toBe(0);
  });

  it('audits a successful setup', async () => {
    const setupToken = await readToken();
    await setup({ setupToken, username: 'owner', password: PASSWORD }).expect(200);
    await vi.waitFor(async () =>
      expect(await prisma.auditEvent.count({ where: { action: 'auth.setup' } })).toBe(1),
    );
    const event = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'auth.setup' } });
    expect(event).toMatchObject({ outcome: 'success', username: 'owner' });
    expect(JSON.stringify(event)).not.toContain(setupToken);
  });
});
