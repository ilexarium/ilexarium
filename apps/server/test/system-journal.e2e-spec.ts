import { connect } from 'node:net';
import { PasswordHasher } from '@nestjs/authentication';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { JOURNAL_LIMITS, type JournalLine } from '@ilex/shared';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { type Client, connectSignedIn, testHasher } from './realtime-client.js';

// The journal end to end, through the helper on the development SSH server (dev/sshd): its fake
// journalctl has three boots of sample lines (no journald in a container), and shows anna only
// her own unless she reads as administrator — ilex-root, through her sudo once unlocked.
// Skipped when the SSH server isn't running (npm run db:up starts it).

const ANNA = { username: 'anna', password: 'anna-dev-password' };

const sshdUp = await new Promise<boolean>((done) => {
  const socket = connect(2222, '127.0.0.1');
  socket.once('connect', () => (socket.destroy(), done(true)));
  socket.once('error', () => done(false));
});

describe.skipIf(!sshdUp)('system journal (e2e)', () => {
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

  const get = (path: string) =>
    request(client.session!.origin).get(`/api${path}`).set('Cookie', client.session!.cookie);
  const post = (path: string, body: object = {}) =>
    request(client.session!.origin)
      .post(`/api${path}`)
      .set('Origin', client.session!.origin)
      .set('Cookie', client.session!.cookie)
      .send(body);
  const signIn = () => post('/files/session', ANNA).expect(200);
  const unlock = () => post('/files/session/sudo', { password: ANNA.password }).expect(200);
  const lines = (body: { lines: JournalLine[] }) => body.lines;

  it('needs a Linux session (403, never 401); refuses odd queries', async () => {
    const res = await get('/system/journal');
    expect([res.status, res.body.code]).toEqual([403, 'linux_session_required']);
    for (const query of ['unit=nginx', 'priority=3', 'boot=0', 'after=a%20b', 'lines=10']) {
      expect((await get(`/system/journal?${query}`)).status, query).toBe(400);
    }
  });

  it('reads the account’s own lines, newest last, then only what’s newer', async () => {
    await signIn();
    const { body } = await get('/system/journal').expect(200);
    expect(body.access).toBe('own');
    // The fake journal's current boot grows a line every 5 s from the container's first read:
    // after a few hours anna has more than one answer's worth.
    expect(body.more).toBe(lines(body).length === JOURNAL_LIMITS.linesPerRead);
    expect(lines(body).length).toBeGreaterThan(100);
    expect(lines(body).every((line) => line.identifier === 'anna-script')).toBe(true);
    const at = lines(body).map((line) => line.at);
    expect([...at].sort()).toEqual(at);
    const last = lines(body).at(-1)!;
    const newer = await get(`/system/journal?after=${encodeURIComponent(last.cursor)}`).expect(200);
    expect(lines(newer.body).every((line) => line.at > last.at)).toBe(true);

    const boots = await get('/system/journal/boots').expect(200);
    expect(boots.body.access).toBe('own');
    expect(boots.body.boots.map((b: { offset: number }) => b.offset)).toEqual([0, -1, -2]);
  });

  it('as administrator through sudo only: everything, a unit, a priority, a boot, paged back', async () => {
    await signIn();
    const locked = await get('/system/journal?administrator=true');
    expect([locked.status, locked.body.code]).toEqual([403, 'sudo_required']);
    await unlock();

    const all = await get('/system/journal?administrator=true&priority=debug').expect(200);
    expect(all.body).toMatchObject({ access: 'all', more: true });
    expect(lines(all.body)).toHaveLength(500);
    // A message that isn't UTF-8 and a repeated field, as text.
    expect(lines(all.body).some((line) => line.text === 'caf� latin-1: �')).toBe(true);
    expect(lines(all.body).some((line) => line.identifier === 'nginx')).toBe(true);

    const first = lines(all.body)[0]!;
    const older = await get(
      `/system/journal?administrator=true&priority=debug&before=${encodeURIComponent(first.cursor)}`,
    ).expect(200);
    expect(lines(older.body)).toHaveLength(500);
    expect(lines(older.body).at(-1)!.at <= first.at).toBe(true);
    expect(lines(older.body).map((l) => l.cursor)).not.toContain(first.cursor);

    const errors = await get(
      '/system/journal?administrator=true&priority=error&unit=proton.VPN.service&boot=-1',
    ).expect(200);
    expect(lines(errors.body).length).toBe(50);
    expect(
      lines(errors.body).every((l) => l.unit === 'proton.VPN.service' && l.priority === 3),
    ).toBe(true);

    const boots = await get('/system/journal/boots?administrator=true').expect(200);
    const previous = boots.body.boots[1];
    const byId = await get(`/system/journal?administrator=true&boot=${previous.id}`).expect(200);
    expect(lines(byId.body).at(-1)!.at <= previous.last).toBe(true);
  });
});
