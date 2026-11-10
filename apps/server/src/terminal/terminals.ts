import type { IncomingMessage } from 'node:http';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { type AuthenticationResult, WsAuthenticator } from '@nestjs/authentication';
import { TERMINAL_CLOSE_CODES, terminalControlSchema, terminalOpenQuerySchema } from '@ilex/shared';
import { WebSocket, type RawData } from 'ws';
import { AuditService } from '../audit/audit.service.js';
import { LinuxSessions } from '../linux-sessions/linux-sessions.js';
import { isSameOrigin } from '../realtime/same-origin.js';
import { TerminalTickets } from './terminal-tickets.js';
import {
  GOING_AWAY,
  HIGH_WATER,
  INTERNAL_ERROR,
  LOW_WATER,
  POLICY_VIOLATION,
  SESSION_RECHECK_MS,
} from './terminal.constants.js';

interface OpenTerminal {
  client: WebSocket;
  end(code: number, reason: string): void;
}

/**
 * The web terminal (docs/plans/files_and_terminal.md, step 2): a socket joined to a shell of the
 * app session's Linux account.
 *
 * - **Admission** — same origin, a live app session, and a one-time ticket that session got with
 *   its app password (`TerminalTickets`); then a shell on the Linux session. Refused: closed.
 * - **Bytes** — binary frames are keystrokes (they count as use of the Linux session) and output;
 *   text frames are control messages (resize), checked. Backpressure both ways: a slow browser
 *   pauses the shell, a slow shell pauses the socket.
 * - **One per app session** — a new one replaces the old.
 * - **Closing** — together with the shell (`exit`), the Linux session (idle, closed, the app's
 *   sign-out: then 4401) and the app session (re-checked every 30 s). Audited when it opens and
 *   closes; never what is typed or shown.
 */
@Injectable()
export class Terminals implements OnModuleDestroy {
  private readonly logger = new Logger(Terminals.name);
  private readonly terminals = new Map<string, OpenTerminal>();

  constructor(
    private readonly wsAuthenticator: WsAuthenticator,
    private readonly linuxSessions: LinuxSessions,
    private readonly terminalTickets: TerminalTickets,
    private readonly auditService: AuditService,
  ) {}

  onModuleDestroy(): void {
    for (const terminal of this.terminals.values()) terminal.end(GOING_AWAY, 'shutdown');
  }

  /** Never rejects: whatever goes wrong closes the socket. */
  async open(client: WebSocket, request: IncomingMessage): Promise<void> {
    // Nothing is read until the shell is there (keystrokes wait instead of getting lost).
    client.pause();
    try {
      await this.admit(client, request);
    } catch (error) {
      this.logger.error('Opening a terminal failed', (error as Error).stack);
      if (client.readyState === WebSocket.OPEN)
        closeSocket(client, INTERNAL_ERROR, 'Internal Error');
    }
  }

  private async admit(client: WebSocket, request: IncomingMessage): Promise<void> {
    if (!isSameOrigin(request.headers))
      return closeSocket(client, POLICY_VIOLATION, 'Origin not allowed');
    const query = terminalOpenQuerySchema.safeParse(
      Object.fromEntries(new URL(request.url ?? '/', 'http://terminal').searchParams),
    );
    if (!query.success) return closeSocket(client, POLICY_VIOLATION, 'Bad request');
    const auth = await this.authenticate(client, request);
    if (client.readyState !== WebSocket.OPEN) return;
    if (!auth?.session)
      return closeSocket(client, TERMINAL_CLOSE_CODES.sessionEnded, 'Session required');
    const appSessionId = auth.session.id;
    if (!this.terminalTickets.take(query.data.ticket, appSessionId)) {
      return closeSocket(client, TERMINAL_CLOSE_CODES.ticketRefused, 'Ticket refused');
    }
    const shell = await this.linuxSessions
      .shell(appSessionId, { cols: query.data.cols, rows: query.data.rows })
      .catch(() => null);
    if (client.readyState !== WebSocket.OPEN) {
      shell?.channel.close();
      return;
    }
    if (!shell)
      return closeSocket(client, TERMINAL_CLOSE_CODES.linuxSessionEnded, 'No Linux session');

    this.terminals.get(appSessionId)?.end(TERMINAL_CLOSE_CODES.replaced, 'replaced');
    const { channel, username } = shell;
    const actor = {
      userId: auth.user.id,
      username: auth.user.username,
      ip: request.socket.remoteAddress,
    };
    let ended = false;
    let outputPaused = false;

    const end = (code: number, reason: string) => {
      if (ended) return;
      ended = true;
      clearInterval(recheck);
      stopFollowing();
      if (this.terminals.get(appSessionId)?.client === client) this.terminals.delete(appSessionId);
      channel.close();
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        closeSocket(client, code, reason);
      }
      void this.auditService.tryRecord({
        action: 'terminal.close',
        outcome: 'success',
        ...actor,
        details: { linuxUser: username, reason },
      });
    };

    const output = (chunk: Buffer) => {
      if (client.readyState !== WebSocket.OPEN) return;
      client.send(chunk, { binary: true }, () => {
        if (outputPaused && client.bufferedAmount < LOW_WATER) {
          outputPaused = false;
          channel.resume();
        }
      });
      if (!outputPaused && client.bufferedAmount > HIGH_WATER) {
        outputPaused = true;
        channel.pause();
      }
    };
    channel.on('data', output);
    channel.stderr.on('data', output);
    channel.on('close', () => end(TERMINAL_CLOSE_CODES.exited, 'exited'));

    client.on('message', (data: RawData, isBinary: boolean) => {
      if (ended) return;
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
      if (isBinary) {
        this.linuxSessions.touch(appSessionId);
        if (!channel.write(bytes)) {
          client.pause();
          channel.once('drain', () => client.resume());
        }
        return;
      }
      const control = parseControl(bytes);
      if (!control) return end(POLICY_VIOLATION, 'bad-message');
      channel.setWindow(control.rows, control.cols, 0, 0);
    });
    client.on('close', () => end(GOING_AWAY, 'browser-closed'));
    client.on('error', () => end(GOING_AWAY, 'browser-error'));

    const stopFollowing = shell.onSessionClose((why) =>
      why === 'app-sign-out'
        ? end(TERMINAL_CLOSE_CODES.sessionEnded, 'app-sign-out')
        : end(TERMINAL_CLOSE_CODES.linuxSessionEnded, `linux-${why}`),
    );
    // A re-check still going: the next one is skipped (a slow session store mustn't pile them up).
    let rechecking = false;
    const recheck = setInterval(() => {
      if (rechecking) return;
      rechecking = true;
      this.authenticate(client)
        .then(
          (result) => {
            // As at admission: the app session it was opened with, still there.
            if (result?.session?.id !== appSessionId) {
              end(TERMINAL_CLOSE_CODES.sessionEnded, 'session-ended');
            }
          },
          (error: unknown) =>
            this.logger.error('Re-checking a terminal session failed', (error as Error).stack),
        )
        .finally(() => (rechecking = false));
    }, SESSION_RECHECK_MS);
    recheck.unref();

    this.terminals.set(appSessionId, { client, end });
    await this.auditService.tryRecord({
      action: 'terminal.open',
      outcome: 'success',
      ...actor,
      details: { linuxUser: username },
    });
    client.resume();
  }

  /** `required: false`: the closing is ours, with our codes. */
  private async authenticate(
    client: WebSocket,
    request?: IncomingMessage,
  ): Promise<AuthenticationResult | null> {
    const result = await this.wsAuthenticator.authenticateConnection(client, request, {
      required: false,
    });
    return result as AuthenticationResult | null;
  }
}

/** A text frame: a valid control message, or null. */
function parseControl(bytes: Buffer) {
  try {
    const parsed = terminalControlSchema.safeParse(JSON.parse(bytes.toString('utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Closes the socket — reading again first, so the browser's close reply isn't left unread. */
function closeSocket(client: WebSocket, code: number, reason: string): void {
  client.resume();
  client.close(code, reason);
}
