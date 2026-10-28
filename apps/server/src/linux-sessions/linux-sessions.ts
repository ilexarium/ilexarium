import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthenticationEvents } from '@nestjs/authentication';
import {
  FILES_ERROR_CODES,
  type FilesErrorCode,
  type LinuxSession,
  type LinuxSignInRequest,
} from '@laris/shared';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { filter, type Subscription } from 'rxjs';
import { Client, type ClientChannel, type SFTPWrapper } from 'ssh2';
import { AuditService } from '../audit/audit.service.js';
import type { Env } from '../config/env.schema.js';
import { linuxError, linuxSessionRequired } from './linux-session-errors.js';
import { LinuxHelper } from './linux-helper.js';
import {
  CONNECT_TIMEOUT_MS,
  HELPER_QUICK_MS,
  HELPER_TIMEOUT_MS,
  HOST_KEY_FILE,
  IDLE_MS,
  KEEPALIVE_COUNT_MAX,
  KEEPALIVE_INTERVAL_MS,
  SSH_HOST,
  SUDO_ERRORS,
  SUDO_ESTIMATE_MS,
} from './linux-sessions.constants.js';
import type {
  HelperAnswer,
  HelperRequest,
  LinuxActor,
  LinuxCloseReason,
  LinuxShell,
  OpenLinuxSession,
} from './linux-sessions.model.js';

/**
 * The Linux sign-in (docs/plans/files_and_terminal.md): an SSH connection to this machine's own
 * `sshd` as a Linux account — `sshd` checks the password, Linux decides everything after. One per
 * app session (by its id), closed after 30 minutes without use, at the app's sign-out (the auth
 * package's events) or on request. The password is used for the handshake only: never kept,
 * logged or audited. The server's host key is pinned (the `ssh_host_*_key.pub` of
 * `SSH_HOST_KEYS`): nothing else can pretend to be `sshd`.
 *
 * Each session runs the helper (`LINUX_HELPER`, docs/plans/acting_as_you.md) as the account, for
 * what Laris does as that person: ending processes, and sudo — unlocked with the same password,
 * kept by sudo's own cache in the helper's terminal, never here.
 */
@Injectable()
export class LinuxSessions implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LinuxSessions.name);
  private readonly sessions = new Map<string, OpenLinuxSession>();
  private readonly port: number;
  private readonly hostKeyDir: string;
  private readonly helperPath: string;
  private hostKeys: Buffer[] = [];
  private signOuts?: Subscription;

  constructor(
    config: ConfigService<Env, true>,
    private readonly authenticationEvents: AuthenticationEvents,
    private readonly auditService: AuditService,
  ) {
    this.port = config.get('SSH_PORT', { infer: true });
    this.hostKeyDir = resolve(config.get('SSH_HOST_KEYS', { infer: true }));
    this.helperPath = config.get('LINUX_HELPER', { infer: true });
  }

  async onModuleInit(): Promise<void> {
    this.signOuts = this.authenticationEvents.events$
      .pipe(filter((event) => event.type === 'sign-out'))
      .subscribe((event) => {
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
    return session ? this.view(session) : null;
  }

  /** The open SFTP channel (counts as use: the idle time starts again), or a 403 `linux_session_required`. */
  sftp(appSessionId: string): { sftp: SFTPWrapper; username: string } {
    const session = this.sessions.get(appSessionId);
    if (!session) throw linuxSessionRequired();
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
    if (!session) throw linuxSessionRequired();
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

  /**
   * Asks the session's helper (counts as use). With `sudo`, the action runs through the account's
   * sudo: its answer moves the estimate (a use restarts sudo's time; `sudo_required`: locked).
   */
  async ask(
    appSessionId: string,
    request: HelperRequest,
    options: { sudo?: boolean } = {},
  ): Promise<HelperAnswer> {
    const session = this.sessions.get(appSessionId);
    if (!session) throw linuxSessionRequired();
    if (!session.helper?.running) {
      throw linuxError(FILES_ERROR_CODES.helperUnavailable, 'This Linux session has no helper');
    }
    session.idle.refresh();
    const answer = await session.helper.request(request, HELPER_TIMEOUT_MS);
    if (options.sudo) {
      if (answer.ok) session.sudoUntil = Date.now() + SUDO_ESTIMATE_MS;
      else if (answer.error === 'sudo_required') session.sudoUntil = null;
    }
    return answer;
  }

  /** Unlocks the account's sudo with its password (sudo -v in the helper's terminal). */
  async unlockSudo(
    appSessionId: string,
    password: string,
    actor: LinuxActor,
  ): Promise<LinuxSession> {
    const session = this.sessions.get(appSessionId);
    if (!session) throw linuxSessionRequired();
    const entry = (outcome: 'success' | 'failure', reason?: string) => ({
      action: 'linux.sudo_unlock' as const,
      outcome,
      userId: actor.user.id,
      username: actor.user.username,
      ip: actor.ip,
      details: { linuxUser: session.username, ...(reason && { reason }) },
    });
    const answer = await this.ask(
      appSessionId,
      { action: 'sudo.unlock', password },
      { sudo: true },
    );
    if (answer.ok) {
      await this.auditService.tryRecord(entry('success'));
      return this.view(session);
    }
    const code =
      SUDO_ERRORS[answer.error] ??
      (answer.error === 'timed_out' || answer.error === 'ended'
        ? FILES_ERROR_CODES.helperUnavailable
        : FILES_ERROR_CODES.failed);
    if (code === FILES_ERROR_CODES.failed) {
      this.logger.warn(`Unlocking sudo for ${session.username} failed: ${answer.error}`);
    }
    await this.auditService.tryRecord(entry('failure', code));
    throw linuxError(code, 'sudo was not unlocked');
  }

  /** "Lock now": sudo -k, and the Linux session ends (signing in again unlocks nothing). */
  async lockSudo(appSessionId: string, actor: LinuxActor): Promise<void> {
    const session = this.sessions.get(appSessionId);
    if (!session) return;
    // Locked even when the helper is gone: closing the session ends its terminal, and sudo's
    // cache with it (a new terminal never has it).
    if (session.helper?.running)
      await session.helper.request({ action: 'sudo.lock' }, HELPER_TIMEOUT_MS);
    this.close(appSessionId, 'locked');
    await this.auditService.tryRecord({
      action: 'linux.sudo_lock',
      outcome: 'success',
      userId: actor.user.id,
      username: actor.user.username,
      ip: actor.ip,
      details: { linuxUser: session.username },
    });
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
      await this.auditService.tryRecord(entry('failure', FILES_ERROR_CODES.linuxRootRefused));
      throw linuxError(FILES_ERROR_CODES.linuxRootRefused, 'root never signs in here');
    }
    // The previous session stays until this one works (a typo never closes a running terminal).
    let client: Client;
    try {
      client = await this.connect(request.username, request.password);
    } catch (error) {
      const code = (error as { code?: FilesErrorCode }).code ?? FILES_ERROR_CODES.sshUnavailable;
      await this.auditService.tryRecord(entry('failure', code));
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
      // No helper (an account without a shell, not installed): its files still open.
      const helper = await LinuxHelper.start(client, this.helperPath).catch((error: Error) => {
        this.logger.warn(`No helper for ${request.username}: ${error.message}`);
        return null;
      });
      // Whose processes it may end.
      const hello = helper ? await helper.request({ action: 'hello' }, HELPER_QUICK_MS) : null;
      const uid = hello?.ok && Number.isSafeInteger(hello['uid']) ? (hello['uid'] as number) : null;
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
        uid,
        helper,
        sudoUntil: null,
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
      await this.auditService.tryRecord(entry('success'));
      return this.view(session);
    } catch (error) {
      // Signed in, but no file access (no SFTP for this account).
      client.end();
      this.logger.warn(`SFTP refused for ${request.username}: ${(error as Error).message}`);
      await this.auditService.tryRecord(entry('failure', FILES_ERROR_CODES.linuxLoginRefused));
      throw linuxError(FILES_ERROR_CODES.linuxLoginRefused, 'This account can’t open its files');
    }
  }

  /** "Close" on the page. */
  async signOut(appSessionId: string, actor: LinuxActor): Promise<void> {
    const session = this.sessions.get(appSessionId);
    if (!session) return;
    this.close(appSessionId, 'closed');
    await this.auditService.tryRecord({
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
      void this.auditService.tryRecord({
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

  private view(session: OpenLinuxSession): LinuxSession {
    const until =
      session.sudoUntil !== null && session.sudoUntil > Date.now() ? session.sudoUntil : null;
    return {
      username: session.username,
      home: session.home,
      uid: session.uid,
      sudoUntil: until === null ? null : new Date(until).toISOString(),
    };
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
          keepaliveInterval: KEEPALIVE_INTERVAL_MS,
          keepaliveCountMax: KEEPALIVE_COUNT_MAX,
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
      names = (await readdir(this.hostKeyDir)).filter((name) => HOST_KEY_FILE.test(name));
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
