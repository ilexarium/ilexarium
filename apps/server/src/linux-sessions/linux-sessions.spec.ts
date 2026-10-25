import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import type { AuthenticationEvents } from '@nestjs/authentication';
import { Subject } from 'rxjs';
import type { AuditService } from '../audit/audit.service.js';
import type { Env } from '../config/env.schema.js';

/** The server's host key as its .pub file holds it, and as ssh2 hands it to hostVerifier. */
const HOST_KEY = Buffer.from('the pinned host key');
let serverKey = HOST_KEY;
let refuse = false;
const clients: FakeClient[] = [];
/** What the fake account's shell answers: by command line. */
let answers: Record<string, { code: number; stdout?: string; stderr?: string }> = {};
const ran: { command: string; input: string }[] = [];

class FakeClient extends EventEmitter {
  ended = false;
  options: Record<string, unknown> = {};
  connect(options: Record<string, unknown>) {
    this.options = options;
    clients.push(this);
    setImmediate(() => {
      const verify = options['hostVerifier'] as (key: Buffer) => boolean;
      if (!verify(serverKey)) return this.emit('error', new Error('host key refused'));
      if (refuse)
        return this.emit(
          'error',
          Object.assign(new Error('auth'), { level: 'client-authentication' }),
        );
      this.emit('ready');
    });
    return this;
  }
  sftp(done: (error: Error | undefined, sftp: unknown) => void) {
    done(undefined, {
      realpath: (_p: string, cb: (e: undefined, p: string) => void) => cb(undefined, '/home/anna'),
    });
  }
  exec(command: string, done: (error: Error | undefined, channel: unknown) => void) {
    const channel = Object.assign(new EventEmitter(), {
      stderr: new EventEmitter(),
      close: () => channel.emit('close', null),
      end: (input: string) => {
        ran.push({ command, input });
        const answer = answers[command];
        setImmediate(() => {
          if (!answer) return; // hangs
          if (answer.stdout) channel.emit('data', Buffer.from(answer.stdout));
          if (answer.stderr) channel.stderr.emit('data', Buffer.from(answer.stderr));
          channel.emit('close', answer.code);
        });
      },
    });
    done(undefined, channel);
  }
  end() {
    this.ended = true;
    this.emit('close');
  }
}

vi.mock('ssh2', () => ({ Client: FakeClient }));
const { LinuxSessions } = await import('./linux-sessions.js');

const USER = {
  id: 'u1',
  username: 'owner',
  createdAt: '2026-10-12T00:00:00.000Z',
  displayName: null,
  email: null,
  language: null,
  avatar: null,
};
const ACTOR = { user: USER, ip: '127.0.0.1' };

describe('LinuxSessions', () => {
  let dir: string;
  let events: Subject<Record<string, unknown>>;
  let audit: { tryRecord: ReturnType<typeof vi.fn> };
  let sessions: InstanceType<typeof LinuxSessions>;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    clients.length = 0;
    serverKey = HOST_KEY;
    refuse = false;
    answers = { 'id -u': { code: 0, stdout: '1500\n' } };
    ran.length = 0;
    dir = mkdtempSync(join(tmpdir(), 'host-keys-'));
    writeFileSync(
      join(dir, 'ssh_host_ed25519_key.pub'),
      `ssh-ed25519 ${HOST_KEY.toString('base64')} root@box\n`,
    );
    writeFileSync(
      join(dir, 'not_a_key.pub'),
      `ssh-ed25519 ${Buffer.from('other').toString('base64')}\n`,
    );
    events = new Subject();
    audit = { tryRecord: vi.fn(async () => undefined) };
    const config = {
      get: (key: string) => (key === 'SSH_PORT' ? 2222 : dir),
    } as unknown as ConfigService<Env, true>;
    sessions = new LinuxSessions(
      config,
      { events$: events.asObservable() } as unknown as AuthenticationEvents,
      audit as unknown as AuditService,
    );
    await sessions.onModuleInit();
  });

  afterEach(() => {
    sessions.onModuleDestroy();
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  const signIn = (sessionId = 's1') =>
    sessions.signIn(sessionId, { username: 'anna', password: 'pw' }, ACTOR);

  it('connects to this machine only, with the password, and keeps one session per app session', async () => {
    expect(await signIn()).toEqual({ username: 'anna', home: '/home/anna', uid: 1500 });
    expect(clients[0].options).toMatchObject({
      host: '127.0.0.1',
      port: 2222,
      username: 'anna',
      password: 'pw',
    });
    expect(sessions.current('s1')).toEqual({ username: 'anna', home: '/home/anna', uid: 1500 });
    await signIn();
    expect(clients[0].ended).toBe(true); // replaced
    expect(sessions.current('other')).toBeNull();
  });

  it('a shell that can’t say its uid (nologin) still signs in, without one', async () => {
    answers = { 'id -u': { code: 1, stderr: 'This account is currently not available.' } };
    expect(await signIn()).toMatchObject({ uid: null });
  });

  it('runs a command as the account: its input on stdin, its exit and output back', async () => {
    await signIn();
    answers['env LC_ALL=C kill -s TERM -- 7'] = { code: 1, stderr: 'kill: (7) - No such process' };
    const command = 'env LC_ALL=C kill -s TERM -- 7' as Parameters<typeof sessions.run>[1];
    expect(await sessions.run('s1', command, 'x\n')).toEqual({
      code: 1,
      stdout: '',
      stderr: 'kill: (7) - No such process',
    });
    expect(ran.at(-1)).toEqual({ command: 'env LC_ALL=C kill -s TERM -- 7', input: 'x\n' });
    await expect(sessions.run('other', command)).rejects.toMatchObject({
      response: { code: 'linux_session_required' },
    });
  });

  it('gives up on a command that doesn’t finish', async () => {
    await signIn();
    const command = 'env LC_ALL=C kill -s TERM -- 8' as Parameters<typeof sessions.run>[1];
    const refused = expect(sessions.run('s1', command)).rejects.toMatchObject({
      response: { code: 'ssh_unavailable' },
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await refused;
  });

  it('a refused sign-in keeps the running session (a typo never closes a terminal)', async () => {
    await signIn();
    refuse = true;
    await expect(signIn()).rejects.toMatchObject({ response: { code: 'linux_login_refused' } });
    expect(sessions.current('s1')).not.toBeNull();
    expect(clients[0].ended).toBe(false);
  });

  it('two sign-ins at once: one session stays, the other connection is closed', async () => {
    await Promise.all([signIn(), signIn()]);
    expect(sessions.current('s1')).not.toBeNull();
    expect(clients.filter((c) => !c.ended)).toHaveLength(1);
    // The closed one's idle time never ends the session that stayed.
    vi.advanceTimersByTime(29 * 60_000);
    sessions.sftp('s1');
    vi.advanceTimersByTime(2 * 60_000);
    expect(sessions.current('s1')).not.toBeNull();
  });

  it('refuses a server whose host key isn’t pinned', async () => {
    serverKey = Buffer.from('someone else');
    await expect(signIn()).rejects.toMatchObject({ response: { code: 'ssh_unavailable' } });
    expect(sessions.current('s1')).toBeNull();
  });

  it('a refused password: linux_login_refused, audited without the password', async () => {
    refuse = true;
    await expect(signIn()).rejects.toMatchObject({ response: { code: 'linux_login_refused' } });
    expect(JSON.stringify(audit.tryRecord.mock.calls)).not.toContain('pw"');
  });

  it('refuses root before connecting', async () => {
    await expect(
      sessions.signIn('s1', { username: 'root', password: 'x' }, ACTOR),
    ).rejects.toMatchObject({
      response: { code: 'linux_root_refused' },
    });
    expect(clients).toHaveLength(0);
  });

  it('closes after 30 minutes without use; using it starts the time again', async () => {
    await signIn();
    vi.advanceTimersByTime(20 * 60_000);
    sessions.sftp('s1');
    vi.advanceTimersByTime(20 * 60_000);
    expect(sessions.current('s1')).not.toBeNull();
    vi.advanceTimersByTime(10 * 60_000);
    expect(sessions.current('s1')).toBeNull();
    expect(clients[0].ended).toBe(true);
    expect(() => sessions.sftp('s1')).toThrow();
  });

  it('closes at the app’s sign-out: that session, or every one of the user (everywhere)', async () => {
    await signIn('s1');
    await signIn('s2');
    events.next({ type: 'sign-out', userId: 'u1', sessionId: 's1' });
    expect(sessions.current('s1')).toBeNull();
    expect(sessions.current('s2')).not.toBeNull();
    events.next({ type: 'sign-out', userId: 'u1', everywhere: true });
    expect(sessions.current('s2')).toBeNull();
  });

  it('forgets a session the server ended', async () => {
    await signIn();
    clients[0].emit('close');
    expect(sessions.current('s1')).toBeNull();
  });
});
