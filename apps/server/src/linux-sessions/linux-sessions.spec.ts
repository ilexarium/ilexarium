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
const HELPER = '/opt/laris/libexec/laris-helper.mts';
/** How the fake helper behaves: answers, not installed, refusing to start, or never answering. */
let helperMode: 'answers' | 'missing' | 'refuses' | 'silent' = 'answers';
/** Its answers, by action. */
let helperAnswers: Record<string, Record<string, unknown>> = {};
const asked: Record<string, unknown>[] = [];
const started: { command: string; options: Record<string, unknown> }[] = [];

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
  exec(
    command: string,
    options: Record<string, unknown>,
    done: (error: Error | undefined, channel: unknown) => void,
  ) {
    started.push({ command, options });
    const channel = Object.assign(new EventEmitter(), {
      close: () => setImmediate(() => channel.emit('close')),
      write: (line: string) => {
        const request = JSON.parse(line) as Record<string, unknown>;
        asked.push(request);
        if (helperMode === 'silent') return;
        const answer = helperAnswers[request['action'] as string] ?? { ok: true };
        // The terminal turns "\n" into "\r\n", and an answer may arrive in pieces.
        const text = `${JSON.stringify({ id: request['id'], ...answer })}\r\n`;
        setImmediate(() => {
          channel.emit('data', Buffer.from(text.slice(0, 5)));
          channel.emit('data', Buffer.from(text.slice(5)));
        });
      },
    });
    done(undefined, channel);
    setImmediate(() => {
      if (helperMode === 'missing') {
        channel.emit('data', Buffer.from('bash: laris-helper.mts: No such file or directory\r\n'));
        channel.emit('close');
        return;
      }
      channel.emit('data', Buffer.from('Welcome to the box!\r\n'));
      const ready =
        helperMode === 'refuses' ? { 'laris-helper': 1, error: 'setup' } : { 'laris-helper': 1 };
      channel.emit('data', Buffer.from(`${JSON.stringify(ready)}\r\n`));
    });
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
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    clients.length = 0;
    serverKey = HOST_KEY;
    refuse = false;
    helperMode = 'answers';
    helperAnswers = { hello: { ok: true, uid: 1500, user: 'anna', home: '/home/anna' } };
    asked.length = 0;
    started.length = 0;
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
      get: (key: string) => ({ SSH_PORT: 2222, LINUX_HELPER: HELPER })[key] ?? dir,
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

  const SESSION = { username: 'anna', home: '/home/anna', uid: 1500, sudoUntil: null };

  it('connects to this machine only, with the password, and keeps one session per app session', async () => {
    expect(await signIn()).toEqual(SESSION);
    expect(clients[0].options).toMatchObject({
      host: '127.0.0.1',
      port: 2222,
      username: 'anna',
      password: 'pw',
    });
    expect(sessions.current('s1')).toEqual(SESSION);
    await signIn();
    expect(clients[0].ended).toBe(true); // replaced
    expect(sessions.current('other')).toBeNull();
  });

  it('starts the helper with a terminal, past the login’s greeting, and asks it who it is', async () => {
    await signIn();
    expect(started).toEqual([{ command: HELPER, options: { pty: expect.any(Object) } }]);
    expect(asked).toEqual([{ id: 1, action: 'hello' }]);
  });

  it('without a helper (missing, or refusing to start) still signs in, without administrator actions', async () => {
    for (const mode of ['missing', 'refuses'] as const) {
      helperMode = mode;
      expect(await signIn()).toEqual({ ...SESSION, uid: null });
      await expect(
        sessions.ask('s1', {
          action: 'process.signal',
          pid: 9,
          signal: 'TERM',
          administrator: false,
        }),
      ).rejects.toMatchObject({ response: { code: 'helper_unavailable' } });
    }
  });

  it('asks the helper, and gives up on one that doesn’t answer', async () => {
    await signIn();
    helperAnswers['process.signal'] = { ok: false, error: 'not_found' };
    const request = {
      action: 'process.signal',
      pid: 7,
      signal: 'TERM',
      administrator: false,
    } as const;
    expect(await sessions.ask('s1', request)).toEqual({ ok: false, error: 'not_found' });
    expect(asked.at(-1)).toEqual({ id: 2, ...request });
    await expect(sessions.ask('other', request)).rejects.toMatchObject({
      response: { code: 'linux_session_required' },
    });
    helperMode = 'silent';
    const answer = sessions.ask('s1', request);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await answer).toEqual({ ok: false, error: 'timed_out' });
  });

  it('unlocks sudo with the password, audited without it; the estimate follows sudo’s answers', async () => {
    await signIn();
    const unlocked = await sessions.unlockSudo('s1', 'pw', ACTOR);
    expect(asked.at(-1)).toEqual({ id: 2, action: 'sudo.unlock', password: 'pw' });
    expect(unlocked.sudoUntil).toBe(new Date(Date.now() + 15 * 60_000).toISOString());
    expect(audit.tryRecord).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'linux.sudo_unlock', outcome: 'success' }),
    );
    expect(JSON.stringify(audit.tryRecord.mock.calls)).not.toContain('pw"');

    // A use restarts sudo's time; sudo saying it's locked ends the estimate.
    const signal = {
      action: 'process.signal',
      pid: 7,
      signal: 'TERM',
      administrator: true,
    } as const;
    vi.advanceTimersByTime(10 * 60_000);
    await sessions.ask('s1', signal, { sudo: true });
    vi.advanceTimersByTime(10 * 60_000);
    expect(sessions.current('s1')?.sudoUntil).not.toBeNull();
    helperAnswers['process.signal'] = { ok: false, error: 'sudo_required' };
    await sessions.ask('s1', signal, { sudo: true });
    expect(sessions.current('s1')?.sudoUntil).toBeNull();
  });

  it('the estimate runs out after 15 minutes without use', async () => {
    await signIn();
    await sessions.unlockSudo('s1', 'pw', ACTOR);
    sessions.sftp('s1');
    vi.advanceTimersByTime(15 * 60_000 + 1);
    expect(sessions.current('s1')?.sudoUntil).toBeNull();
  });

  it('a password sudo refuses, or an account it refuses: 403 with its code, audited', async () => {
    await signIn();
    for (const [error, code] of [
      ['wrong_password', 'sudo_password_wrong'],
      ['sudo_not_allowed', 'sudo_not_allowed'],
      ['sudo_unavailable', 'sudo_not_allowed'],
    ]) {
      helperAnswers['sudo.unlock'] = { ok: false, error };
      await expect(sessions.unlockSudo('s1', 'pw', ACTOR)).rejects.toMatchObject({
        status: 403,
        response: { code },
      });
      expect(audit.tryRecord).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: 'linux.sudo_unlock',
          outcome: 'failure',
          details: { linuxUser: 'anna', reason: code },
        }),
      );
    }
    expect(sessions.current('s1')?.sudoUntil).toBeNull();
  });

  it('“Lock now” locks sudo and ends the Linux session', async () => {
    await signIn();
    await sessions.unlockSudo('s1', 'pw', ACTOR);
    await sessions.lockSudo('s1', ACTOR);
    expect(asked.at(-1)).toMatchObject({ action: 'sudo.lock' });
    expect(sessions.current('s1')).toBeNull();
    expect(clients[0].ended).toBe(true);
    expect(audit.tryRecord).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'linux.sudo_lock', outcome: 'success' }),
    );
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
