import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthenticationEvents } from '@nestjs/authentication';
import {
  type ApiErrorResponse,
  FILES_ERROR_CODES,
  FILES_LIMITS,
  type FilesErrorCode,
  type LinuxSession,
  type LinuxSignInRequest,
} from '@laris/shared';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Subscription } from 'rxjs';
import { Client, type ClientChannel, type SFTPWrapper } from 'ssh2';
import { AuditService } from '../audit/audit.service.js';
import type { Env } from '../config/env.schema.js';
import type {
  LinuxActor,
  LinuxCloseReason,
  LinuxShell,
  OpenLinuxSession,
} from './linux-sessions.model.js';

/** The machine's own SSH server: never another one. */
const SSH_HOST = '127.0.0.1';
const IDLE_MS = FILES_LIMITS.idleMinutes * 60_000;
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Never 401 for the Linux side: in this app a 401 means the *app* session is missing, and the web
 * app signs the person out on it. A refused Linux password or an ended Linux session is a 403,
 * told apart by its code.
 */
const STATUS: Partial<Record<FilesErrorCode, HttpStatus>> = {
  [FILES_ERROR_CODES.linuxSessionRequired]: HttpStatus.FORBIDDEN,
  [FILES_ERROR_CODES.linuxLoginRefused]: HttpStatus.FORBIDDEN,
  [FILES_ERROR_CODES.linuxRootRefused]: HttpStatus.FORBIDDEN,
  [FILES_ERROR_CODES.sshUnavailable]: HttpStatus.SERVICE_UNAVAILABLE,
  [FILES_ERROR_CODES.notFound]: HttpStatus.NOT_FOUND,
  [FILES_ERROR_CODES.permissionDenied]: HttpStatus.FORBIDDEN,
  [FILES_ERROR_CODES.exists]: HttpStatus.CONFLICT,
  [FILES_ERROR_CODES.wrongType]: HttpStatus.CONFLICT,
  [FILES_ERROR_CODES.tooLarge]: HttpStatus.PAYLOAD_TOO_LARGE,
  [FILES_ERROR_CODES.failed]: HttpStatus.CONFLICT,
};

export function linuxError(code: FilesErrorCode, message: string): HttpException {
  const body: ApiErrorResponse = { message, code };
  return new HttpException(body, STATUS[code] ?? HttpStatus.BAD_GATEWAY);
}

/**
 * The Linux sign-in (docs/plans/files_and_terminal.md): an SSH connection to this machine's own
 * `sshd` as a Linux account — `sshd` checks the password, Linux decides everything after. One per
 * app session (by its id), closed after 30 minutes without use, at the app's sign-out (the auth
 * package's events) or on request. The password is used for the handshake only: never kept,
 * logged or audited. The server's host key is pinned (the `ssh_host_*_key.pub` of
 * `SSH_HOST_KEYS`): nothing else can pretend to be `sshd`.
 */
@Injectable()
export class LinuxSessions implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LinuxSessions.name);
  private readonly sessions = new Map<string, OpenLinuxSession>();
  private readonly port: number;
  private readonly hostKeyDir: string;
  private hostKeys: Buffer[] = [];
  private signOuts?: Subscription;

  constructor(
    config: ConfigService<Env, true>,
    private readonly authEvents: AuthenticationEvents,
    private readonly audit: AuditService,
  ) {
    this.port = config.get('SSH_PORT', { infer: true });
    this.hostKeyDir = resolve(config.get('SSH_HOST_KEYS', { infer: true }));
  }

  async onModuleInit(): Promise<void> {
    this.signOuts = this.authEvents.events$.subscribe((event) => {
      if (event.type !== 'sign-out') return;
      for (const [sessionId, session] of this.sessions) {
        const ended = event.everywhere
          ? session.userId === event.userId
          : sessionId === event.sessionId;
        if (ended) this.close(sessionId, 'app-sign-out');
      }
    });
    await this.loadHostKeys();
  }

  onModuleDestroy(): void {
    this.signOuts?.unsubscribe();
    // Deleting while iterating a Map is safe.
    for (const sessionId of this.sessions.keys()) this.close(sessionId, 'shutdown');
  }

  /** The Linux session of this app session, or null. */
  current(appSessionId: string): LinuxSession | null {
    const session = this.sessions.get(appSessionId);
    return session ? { username: session.username, home: session.home } : null;
  }

  /** The open SFTP channel (counts as use: the idle time starts again), or a 403 `linux_session_required`. */
  sftp(appSessionId: string): { sftp: SFTPWrapper; username: string } {
    const session = this.sessions.get(appSessionId);
    if (!session) {
      throw linuxError(FILES_ERROR_CODES.linuxSessionRequired, 'Sign in as a Linux user first');
    }
    session.idle.refresh();
    return { sftp: session.sftp, username: session.username };
  }

  /** Counts as use (terminal input): the idle time starts again. */
  touch(appSessionId: string): void {
    this.sessions.get(appSessionId)?.idle.refresh();
  }

  /**
   * A shell of the signed-in account (a pty, `xterm-256color`) on the session's SSH connection —
   * a login shell like `ssh` gives, with that account's rights and nothing more.
   */
  async shell(appSessionId: string, size: { cols: number; rows: number }): Promise<LinuxShell> {
    const session = this.sessions.get(appSessionId);
    if (!session) {
      throw linuxError(FILES_ERROR_CODES.linuxSessionRequired, 'Sign in as a Linux user first');
    }
    session.idle.refresh();
    const channel = await new Promise<ClientChannel>((ok, fail) =>
      session.client.shell(
        { term: 'xterm-256color', cols: size.cols, rows: size.rows },
        (error, stream) => (error ? fail(error) : ok(stream)),
      ),
    ).catch((error: Error) => {
      this.logger.warn(`No shell for ${session.username}: ${error.message}`);
      throw linuxError(FILES_ERROR_CODES.sshUnavailable, 'The SSH server gave no shell');
    });
    return {
      channel,
      username: session.username,
      onSessionClose: (listener) => {
        session.closing.add(listener);
        return () => session.closing.delete(listener);
      },
    };
  }

  /** Signs in as a Linux user; replaces this app session's previous Linux session. */
  async signIn(
    appSessionId: string,
    request: LinuxSignInRequest,
    actor: LinuxActor,
  ): Promise<LinuxSession> {
    const entry = (outcome: 'success' | 'failure', reason?: string) => ({
      action: 'linux.signin' as const,
      outcome,
      userId: actor.user.id,
      username: actor.user.username,
      ip: actor.ip,
      details: { linuxUser: request.username, ...(reason && { reason }) },
    });
    if (request.username === 'root') {
      await this.audit.tryRecord(entry('failure', FILES_ERROR_CODES.linuxRootRefused));
      throw linuxError(FILES_ERROR_CODES.linuxRootRefused, 'root never signs in here');
    }
    // The previous session stays until this one works (a typo never closes a running terminal).
    let client: Client;
    try {
      client = await this.connect(request.username, request.password);
    } catch (error) {
      const code = (error as { code?: FilesErrorCode }).code ?? FILES_ERROR_CODES.sshUnavailable;
      await this.audit.tryRecord(entry('failure', code));
      throw linuxError(
        code,
        code === FILES_ERROR_CODES.linuxLoginRefused
          ? 'Wrong user name or password'
          : 'The SSH server is not available',
      );
    }
    try {
      const sftp = await new Promise<SFTPWrapper>((ok, fail) =>
        client.sftp((error, channel) => (error ? fail(error) : ok(channel))),
      );
      const home = await new Promise<string>((ok, fail) =>
        sftp.realpath('.', (error, path) => (error ? fail(error) : ok(path))),
      );
      // Closes this session only — never a newer one of the same app session.
      const idle = setTimeout(() => {
        if (this.sessions.get(appSessionId) === session) this.close(appSessionId, 'idle');
      }, IDLE_MS);
      idle.unref();
      const session: OpenLinuxSession = {
        client,
        sftp,
        username: request.username,
        home,
        userId: actor.user.id,
        idle,
        closing: new Set(),
      };
      // Replaces the previous one, also one signed in at the same time (no connection left open).
      this.close(appSessionId, 'replaced');
      this.sessions.set(appSessionId, session);
      // The server ended it (restarted, the account locked): forgotten at once.
      client.on('close', () => {
        if (this.sessions.get(appSessionId) === session) this.forget(appSessionId, 'ended');
      });
      await this.audit.tryRecord(entry('success'));
      return { username: request.username, home };
    } catch (error) {
      // Signed in, but no file access (no SFTP for this account).
      client.end();
      this.logger.warn(`SFTP refused for ${request.username}: ${(error as Error).message}`);
      await this.audit.tryRecord(entry('failure', FILES_ERROR_CODES.linuxLoginRefused));
      throw linuxError(FILES_ERROR_CODES.linuxLoginRefused, 'This account can’t open its files');
    }
  }

  /** "Close" on the page. */
  async signOut(appSessionId: string, actor: LinuxActor): Promise<void> {
    const session = this.sessions.get(appSessionId);
    if (!session) return;
    this.close(appSessionId, 'closed');
    await this.audit.tryRecord({
      action: 'linux.signout',
      outcome: 'success',
      userId: actor.user.id,
      username: actor.user.username,
      ip: actor.ip,
      details: { linuxUser: session.username },
    });
  }

  private close(appSessionId: string, why: LinuxCloseReason): void {
    const session = this.sessions.get(appSessionId);
    if (!session) return;
    this.forget(appSessionId, why);
    session.client.end();
    if (why === 'idle' || why === 'app-sign-out') {
      void this.audit.tryRecord({
        action: 'linux.signout',
        outcome: 'success',
        userId: session.userId,
        details: { linuxUser: session.username, reason: why },
      });
    }
  }

  private forget(appSessionId: string, why: LinuxCloseReason): void {
    const session = this.sessions.get(appSessionId);
    if (!session) return;
    clearTimeout(session.idle);
    this.sessions.delete(appSessionId);
    for (const listener of session.closing) listener(why);
    session.closing.clear();
  }

  private connect(username: string, password: string): Promise<Client> {
    return new Promise((ok, fail) => {
      const client = new Client();
      let hostKeyRefused = false;
      client
        .on('ready', () => ok(client))
        .on('error', (error: Error & { level?: string }) => {
          if (error.level === 'client-authentication') {
            fail(Object.assign(error, { code: FILES_ERROR_CODES.linuxLoginRefused }));
            return;
          }
          if (hostKeyRefused) {
            this.logger.error(`The SSH server on ${SSH_HOST}:${this.port} has an unknown host key`);
          } else {
            this.logger.warn(`The SSH server is not available: ${error.message}`);
          }
          fail(Object.assign(error, { code: FILES_ERROR_CODES.sshUnavailable }));
        })
        .connect({
          host: SSH_HOST,
          port: this.port,
          username,
          password,
          tryKeyboard: false,
          readyTimeout: CONNECT_TIMEOUT_MS,
          keepaliveInterval: 15_000,
          keepaliveCountMax: 3,
          hostVerifier: (key: Buffer) => {
            const known = this.hostKeys.some((hostKey) => hostKey.equals(key));
            if (!known) hostKeyRefused = true;
            return known;
          },
        });
    });
  }

  /** `ssh_host_*_key.pub` files: `<type> <base64 key> [comment]` — the key blobs, pinned. */
  private async loadHostKeys(): Promise<void> {
    let names: string[] = [];
    try {
      names = (await readdir(this.hostKeyDir)).filter((name) =>
        /^ssh_host_\w+_key\.pub$/.test(name),
      );
    } catch {
      // No such folder: no Linux sign-in until it exists (logged below).
    }
    const keys: Buffer[] = [];
    for (const name of names) {
      const [, base64] = (await readFile(join(this.hostKeyDir, name), 'utf8')).trim().split(/\s+/);
      if (base64) keys.push(Buffer.from(base64, 'base64'));
    }
    this.hostKeys = keys;
    if (keys.length === 0) {
      this.logger.warn(`No SSH host keys in ${this.hostKeyDir}: the Linux sign-in is unavailable`);
    }
  }
}
