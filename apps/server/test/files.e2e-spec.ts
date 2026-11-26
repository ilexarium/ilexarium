import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { PasswordHasher } from '@nestjs/authentication';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import contentDisposition from 'content-disposition';
import type { FileList, LinuxSession } from '@ilex/shared';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { UsersService } from '../src/users/users.service.js';
import { resetDatabase } from './database.js';
import { testHasher } from './realtime-client.js';

// The Linux sign-in and the file explorer end to end, against the development SSH server
// (dev/sshd: anna, and bob whose home is private), its host key pinned from .dev/sshd. Skipped
// when it isn't running (npm run db:up starts it).

const PASSWORD = 'correct horse battery staple';
const ANNA = { username: 'anna', password: 'anna-dev-password' };

const sshdUp = await new Promise<boolean>((done) => {
  const socket = connect(2222, '127.0.0.1');
  socket.once('connect', () => (socket.destroy(), done(true)));
  socket.once('error', () => done(false));
});

describe.skipIf(!sshdUp)('files (e2e)', () => {
  let app: NestExpressApplication;
  let origin: string;
  let cookie: string;
  let prisma: PrismaService;
  const folder = `/home/anna/e2e-${Date.now()}`;

  const api = () => ({
    get: (path: string) => request(origin).get(`/api${path}`).set('Cookie', cookie),
    post: (path: string, body: object = {}) =>
      request(origin).post(`/api${path}`).set('Origin', origin).set('Cookie', cookie).send(body),
    put: (path: string, body: Buffer | string) =>
      request(origin)
        .put(`/api${path}`)
        .set('Origin', origin)
        .set('Cookie', cookie)
        .set('Content-Type', 'application/octet-stream')
        .send(body),
    delete: (path: string) =>
      request(origin).delete(`/api${path}`).set('Origin', origin).set('Cookie', cookie),
  });
  const q = (value: string) => encodeURIComponent(value);
  const names = async (path: string) =>
    (
      (
        await api()
          .get(`/files/list?path=${q(path)}`)
          .expect(200)
      ).body as FileList
    ).entries.map((e) => e.name);

  async function signInToApp(): Promise<void> {
    const login = await request(origin)
      .post('/api/auth/login')
      .set('Origin', origin)
      .send({ username: 'owner', password: PASSWORD })
      .expect(200);
    cookie = ([] as string[])
      .concat(login.headers['set-cookie'] ?? [])
      .find((c) => c.startsWith('__Host-sid='))!
      .split(';')[0];
  }

  beforeAll(async () => {
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
    await signInToApp();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it('needs an app session, then a Linux session', async () => {
    await request(origin).get('/api/files/session').expect(401);
    expect((await api().get('/files/session').expect(200)).body).toEqual({ session: null });
    const res = await api()
      .get(`/files/list?path=${q('/home/anna')}`)
      .expect(403); // never 401: that's the app session's (the web app signs out on it)
    expect(res.body.code).toBe('linux_session_required');
  });

  it('refuses a wrong password and root; signs in as anna, starting in her home', async () => {
    const wrong = await api()
      .post('/files/session', { username: 'anna', password: 'nope' })
      .expect(403);
    expect(wrong.body.code).toBe('linux_login_refused');
    const root = await api()
      .post('/files/session', { username: 'root', password: 'x' })
      .expect(403);
    expect(root.body.code).toBe('linux_root_refused');
    const session = (await api().post('/files/session', ANNA).expect(200)).body as LinuxSession;
    expect(session).toEqual({ username: 'anna', home: '/home/anna', uid: 1500, sudoUntil: null });
    expect((await api().get('/files/session').expect(200)).body).toEqual({ session });
    const audit = await prisma.auditEvent.findMany({ where: { action: 'linux.signin' } });
    expect(audit.map((a) => [a.outcome, (a.details as { reason?: string }).reason])).toEqual([
      ['failure', 'linux_login_refused'],
      ['failure', 'linux_root_refused'],
      ['success', undefined],
    ]);
    expect(JSON.stringify(audit)).not.toContain('anna-dev-password');
  });

  it('makes a folder, uploads, downloads (always as an attachment), renames, deletes', async () => {
    await api()
      .post('/files/folder', { parent: '/home/anna', name: folder.split('/').pop() })
      .expect(204);
    await api()
      .post('/files/folder', { parent: '/home/anna', name: folder.split('/').pop() })
      .expect(409);
    const content = Buffer.from('<html><script>alert(1)</script></html>');
    await api()
      .put(`/files/upload?folder=${q(folder)}&name=page.html`, content)
      .expect(204);
    expect(await names(folder)).toEqual(['page.html']);

    const download = await api()
      .get(`/files/download?path=${q(`${folder}/page.html`)}`)
      .expect(200);
    expect(
      Buffer.from(download.body as Buffer).equals(content) || download.text === content.toString(),
    ).toBe(true);
    expect(download.headers['content-type']).toBe('application/octet-stream');
    expect(download.headers['content-disposition']).toMatch(/^attachment; filename="page.html"/);
    expect(download.headers['x-content-type-options']).toBe('nosniff');
    // Its own CSP, stricter than the app's: a file never runs as part of the app.
    expect(download.headers['content-security-policy']).toBe("default-src 'none'; sandbox");

    // Any name comes back whole: quotes, brackets, umlauts, other scripts.
    const odd = `it's (1)* März "x" 日本.txt`;
    await api()
      .put(`/files/upload?folder=${q(folder)}&name=${q(odd)}`, 'odd')
      .expect(204);
    const oddDownload = await api()
      .get(`/files/download?path=${q(`${folder}/${odd}`)}`)
      .expect(200);
    const header = oddDownload.headers['content-disposition'] as string;
    expect(contentDisposition.parse(header)).toEqual({
      type: 'attachment',
      parameters: { filename: odd },
    });
    await api()
      .delete(`/files?path=${q(`${folder}/${odd}`)}`)
      .expect(204);

    const again = await api()
      .put(`/files/upload?folder=${q(folder)}&name=page.html`, 'other')
      .expect(409);
    expect(again.body.code).toBe('file_exists');
    await api()
      .put(`/files/upload?folder=${q(folder)}&name=page.html&replace=true`, 'replaced')
      .expect(204);
    const replaced = await api()
      .get(`/files/download?path=${q(`${folder}/page.html`)}`)
      .expect(200);
    expect(replaced.text || Buffer.from(replaced.body as Buffer).toString()).toBe('replaced');

    await api().post('/files/folder', { parent: folder, name: 'sub' }).expect(204);
    await api()
      .put(`/files/upload?folder=${q(`${folder}/sub`)}&name=a.txt`, 'aaa')
      .expect(204);
    await api()
      .post('/files/rename', { from: `${folder}/page.html`, to: `${folder}/sub/page.html` })
      .expect(204);
    expect(await names(`${folder}/sub`)).toEqual(['a.txt', 'page.html']);
    await api()
      .post('/files/rename', { from: `${folder}/sub/a.txt`, to: `${folder}/sub/page.html` })
      .expect(409);

    const summary = (
      await api()
        .get(`/files/summary?path=${q(folder)}`)
        .expect(200)
    ).body;
    expect(summary).toEqual({
      type: 'folder',
      files: 2,
      folders: 1,
      bytes: 3 + 'replaced'.length,
      truncated: false,
    });

    await api()
      .delete(`/files?path=${q(folder)}`)
      .expect(204);
    expect(await names('/home/anna')).not.toContain(folder.split('/').pop());

    const audit = await prisma.auditEvent.findMany({
      where: { action: { in: ['files.upload', 'files.rename', 'files.delete'] } },
      orderBy: { at: 'asc' },
    });
    expect(audit.map((a) => a.action)).toEqual([
      'files.upload',
      'files.upload', // the oddly named file, and its delete
      'files.delete',
      'files.upload',
      'files.upload',
      'files.rename',
      'files.delete',
    ]);
    expect(audit[0].details).toMatchObject({
      linuxUser: 'anna',
      path: `${folder}/page.html`,
      bytes: content.length,
    });
    expect(JSON.stringify(audit)).not.toContain('alert(1)');
  });

  it('can do only what Linux allows anna: bob’s private home is refused', async () => {
    const list = await api()
      .get(`/files/list?path=${q('/home/bob')}`)
      .expect(403);
    expect(list.body.code).toBe('permission_denied');
    await api()
      .get(`/files/download?path=${q('/home/bob/private.txt')}`)
      .expect(403);
    await api()
      .put(`/files/upload?folder=${q('/home/bob')}&name=x.txt`, 'x')
      .expect(403);
    await api()
      .delete(`/files?path=${q('/etc/hostname')}`)
      .expect(403);
    // Visible but not readable: a clear 403 before anything is sent (not a broken download).
    const shadow = await api()
      .get(`/files/download?path=${q('/etc/shadow')}`)
      .expect(403);
    expect(shadow.body.code).toBe('permission_denied');
    const missing = await api()
      .get(`/files/list?path=${q('/home/anna/nothing-here')}`)
      .expect(404);
    expect(missing.body.code).toBe('file_not_found');
  });

  it('as administrator: root through anna’s own unlocked sudo, closed when it locks', async () => {
    const asRoot = (path: string) => `/files/list?path=${q(path)}&root=true`;
    expect((await api().get(asRoot('/root')).expect(403)).body.code).toBe('sudo_required');
    await api().post('/files/session/sudo', { password: ANNA.password }).expect(200);

    const name = `e2e-${Date.now()}`;
    const rootFolder = `/root/${name}`;
    await api().post('/files/folder', { parent: '/root', name, root: true }).expect(204);
    await api()
      .put(`/files/upload?folder=${q(rootFolder)}&name=a.txt&root=true`, 'as root')
      .expect(204);
    const listed = (await api().get(asRoot(rootFolder)).expect(200)).body as FileList;
    expect(listed.entries.map((e) => [e.name, e.owner])).toEqual([['a.txt', 'root']]);
    const secret = await api()
      .get(`/files/download?path=${q('/home/bob/private.txt')}&root=true`)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect((secret.body as Buffer).toString()).toBe('secret\n');
    await api()
      .post('/files/rename', { from: `${rootFolder}/a.txt`, to: `${rootFolder}/b.txt`, root: true })
      .expect(204);
    // The plain SFTP stays anna's own, unlocked or not.
    expect(
      (
        await api()
          .get(`/files/list?path=${q('/root')}`)
          .expect(403)
      ).body.code,
    ).toBe('permission_denied');
    // A folder goes through ilex-root's removal.
    await api()
      .delete(`/files?path=${q(rootFolder)}&root=true`)
      .expect(204);
    expect(
      ((await api().get(asRoot('/root')).expect(200)).body as FileList).entries.map((e) => e.name),
    ).not.toContain(name);

    const audit = await prisma.auditEvent.findMany({
      where: { action: { in: ['files.upload', 'files.rename', 'files.delete'] } },
      orderBy: { at: 'asc' },
    });
    expect(
      audit.filter((a) => (a.details as { asRoot?: boolean }).asRoot).map((a) => a.action),
    ).toEqual(['files.upload', 'files.rename', 'files.delete']);
    const unlock = await prisma.auditEvent.findFirst({
      where: { action: 'linux.sudo_unlock', outcome: 'success' },
    });
    expect(unlock?.details).toMatchObject({ rootFiles: true });

    // "Lock now": root's SFTP closes with sudo.
    await api().delete('/files/session/sudo').expect(200);
    expect((await api().get(asRoot('/root')).expect(403)).body.code).toBe('sudo_required');
  });

  it('refuses bad requests', async () => {
    await api().get('/files/list?path=relative/path').expect(400);
    await api().post('/files/folder', { parent: '/home/anna', name: '../escape' }).expect(400);
    await api()
      .put(`/files/upload?folder=${q('/home/anna')}&name=a%2Fb`, 'x')
      .expect(400);
    await api()
      .get(`/files/download?path=${q('/home/anna')}`)
      .expect(409);
  });

  it('closes the Linux session at the app’s sign-out', async () => {
    await request(origin)
      .post('/api/auth/logout')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .expect(204);
    await signInToApp();
    expect((await api().get('/files/session').expect(200)).body).toEqual({ session: null });
    await api().post('/files/session', ANNA).expect(200);
    await api().delete('/files/session').expect(204);
    expect((await api().get('/files/session').expect(200)).body).toEqual({ session: null });
  });
});
