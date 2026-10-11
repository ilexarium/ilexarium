import { Controller, Get, Module, Param, Post } from '@nestjs/common';
import { Authenticate, CurrentUser, Public, SignInService } from '@nestjs/authentication';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { PublicUser } from '@homelab/shared';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { UsersService } from '../src/users/users.service.js';
import { resetDatabase } from './database.js';

/** Test-only routes exercising the package wiring before the real auth endpoints exist. */
@Controller('wiring')
class WiringController {
  constructor(private readonly signIn: SignInService) {}

  @Public()
  @Post('sign-in/:userId')
  async signInAs(@Param('userId') userId: string) {
    await this.signIn.signIn(userId, { method: 'test' });
  }

  @Public()
  @Post('sign-out')
  async signOut() {
    await this.signIn.signOut();
  }

  @Get('whoami')
  whoami(@CurrentUser() user: PublicUser) {
    return { user };
  }

  @Authenticate({ optional: true })
  @Get('maybe')
  maybe(@CurrentUser() user: PublicUser | null) {
    return { user };
  }

  @Post('action')
  action() {
    return { done: true };
  }
}

@Module({ controllers: [WiringController] })
class WiringModule {}

const HOST = 'homelab.test';
const SAME_ORIGIN = `http://${HOST}`;

describe('auth wiring (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let users: UsersService;
  let userId: string;

  const http = () => request(app.getHttpServer());
  const post = (path: string, origin = SAME_ORIGIN) =>
    http().post(`/api${path}`).set('Host', HOST).set('Origin', origin);

  /** Signs in and returns the cookie pair to send back (`__Host-sid=…`). */
  async function signIn(): Promise<string> {
    const res = await post(`/wiring/sign-in/${userId}`).expect(201);
    const setCookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    const sid = setCookie.find((cookie) => cookie.startsWith('__Host-sid='));
    expect(sid).toBeDefined();
    return sid!.split(';')[0];
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, WiringModule],
    }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
    prisma = app.get(PrismaService);
    users = app.get(UsersService);
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    ({ id: userId } = await users.create({ username: 'owner', passwordHash: '$scrypt$secret' }));
  });

  afterAll(() => app.close());

  it('denies by default: a route without @Public() needs a session', async () => {
    await http().get('/api/wiring/whoami').expect(401);
  });

  it('keeps @Public() routes open', async () => {
    await http().get('/api/health').expect(200);
  });

  it('sets the session cookie with the intended attributes', async () => {
    const res = await post(`/wiring/sign-in/${userId}`).expect(201);
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] ?? [])[0] ?? '';
    expect(cookie).toMatch(/^__Host-sid=/);
    for (const attribute of [/; HttpOnly/i, /; Secure/i, /; SameSite=Lax/i, /; Path=\//i]) {
      expect(cookie).toMatch(attribute);
    }
    expect(cookie).not.toMatch(/; Domain=/i);
  });

  it('returns the public user for a session — never the password hash', async () => {
    const cookie = await signIn();
    const res = await http().get('/api/wiring/whoami').set('Cookie', cookie).expect(200);
    expect(res.body.user).toMatchObject({ id: userId, username: 'owner' });
    expect(JSON.stringify(res.body)).not.toContain('scrypt');
  });

  it('stores only the SHA-256 of the cookie token', async () => {
    const cookie = await signIn();
    const token = cookie.split('=')[1];
    const [session] = await prisma.session.findMany();
    expect(session.id).not.toContain(token);
    expect(session.id).toMatch(/^[a-f0-9]{64}$|^[A-Za-z0-9_-]{43}$/);
  });

  it('optional routes: null when signed out, the user when signed in, null for a bad cookie', async () => {
    expect((await http().get('/api/wiring/maybe').expect(200)).body).toEqual({ user: null });
    const cookie = await signIn();
    const signedIn = await http().get('/api/wiring/maybe').set('Cookie', cookie).expect(200);
    expect(signedIn.body.user.username).toBe('owner');
    const garbage = await http().get('/api/wiring/maybe').set('Cookie', '__Host-sid=garbage');
    expect(garbage.status).toBe(200);
    expect(garbage.body).toEqual({ user: null });
  });

  it('sign-out ends the session immediately', async () => {
    const cookie = await signIn();
    await post('/wiring/sign-out').set('Cookie', cookie).expect(201);
    await http().get('/api/wiring/whoami').set('Cookie', cookie).expect(401);
    expect(await prisma.session.count()).toBe(0);
  });

  it('deleting the user ends their sessions', async () => {
    const cookie = await signIn();
    await prisma.user.delete({ where: { id: userId } });
    await http().get('/api/wiring/whoami').set('Cookie', cookie).expect(401);
  });

  it('refuses a sign-in posted from another origin (login CSRF)', async () => {
    await post(`/wiring/sign-in/${userId}`, 'https://evil.example').expect(403);
    expect(await prisma.session.count()).toBe(0);
  });

  it('refuses state-changing requests from another origin, even with a valid cookie', async () => {
    const cookie = await signIn();
    const res = await post('/wiring/action', 'https://evil.example').set('Cookie', cookie);
    expect(res.status).toBe(403);
  });

  it('accepts same-origin state-changing requests', async () => {
    const cookie = await signIn();
    await post('/wiring/action').set('Cookie', cookie).expect(201);
  });

  it('records sign-in and sign-out in the audit log', async () => {
    const cookie = await signIn();
    await post('/wiring/sign-out').set('Cookie', cookie).expect(201);
    await vi.waitFor(async () => expect(await prisma.auditEvent.count()).toBe(2));
    const events = await prisma.auditEvent.findMany({ orderBy: { at: 'asc' } });
    expect(events.map((event) => [event.action, event.outcome, event.username])).toEqual([
      ['auth.login', 'success', 'owner'],
      ['auth.logout', 'success', 'owner'],
    ]);
    expect(events[0].details).toEqual({ method: 'test' });
    expect(events[0].ip).toBeTruthy();
  });
});
