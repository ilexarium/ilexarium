import type { IncomingMessage } from 'node:http';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  AuthenticationEvents,
  type AuthenticationResult,
  type AuthenticationSignOutEvent,
  WsAuthenticator,
} from '@nestjs/authentication';
import type { Subscription } from 'rxjs';
import { WS_CLOSE_CODES } from '@laris/shared';
import { WebSocket } from 'ws';
import { MessageRateLimiter } from './message-rate-limiter.js';
import { REALTIME_OPTIONS } from './realtime.options.js';
import { isSameOrigin } from './same-origin.js';
import type { Connection, RealtimeOptions } from './realtime.model.js';

/** RFC 6455 §7.4.1. */
const POLICY_VIOLATION = 1008;
const INTERNAL_ERROR = 1011;

/**
 * Admits or refuses each socket and keeps the admitted ones in check:
 *
 * - **Admission** — same origin, a live session (`WsAuthenticator`, the auth package's handshake
 *   check) and at most `maxConnectionsPerSession` sockets per session. Refused: closed before
 *   anything is sent, `4401` without a session, 1008 otherwise.
 * - **Sign-out** — a session signed out (or every session of a user, "everywhere") closes its
 *   sockets at once with `4401`, so nothing more reaches them — log lines can hold secrets.
 * - **Re-check** — the session again every `sessionRecheckMs`; ended → closed with `4401`. This
 *   catches sessions that end without a sign-out event (expiry, revoked with the password change).
 *   (Every message is also checked by the global authentication guard.)
 *
 * Nest starts delivering messages before the async connection hook finishes, so message handling
 * waits for {@link admitted} — otherwise a cross-site page could subscribe in that gap.
 */
@Injectable()
export class RealtimeConnections implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeConnections.name);
  private readonly admissions = new WeakMap<WebSocket, Promise<Connection | null>>();
  private readonly connections = new Map<WebSocket, Connection>();
  private readonly bySession = new Map<string, Set<WebSocket>>();
  private signOuts?: Subscription;

  constructor(
    private readonly wsAuth: WsAuthenticator,
    private readonly authEvents: AuthenticationEvents,
    @Inject(REALTIME_OPTIONS) private readonly options: RealtimeOptions,
  ) {}

  onModuleInit(): void {
    this.signOuts = this.authEvents.events$.subscribe((event) => {
      if (event.type === 'sign-out') this.closeSignedOut(event);
    });
  }

  /** Call synchronously when the socket opens, before any message can arrive. Never rejects. */
  admit(client: WebSocket, request: IncomingMessage): Promise<Connection | null> {
    const admission = this.check(client, request).catch((error: unknown) => {
      this.logger.error('Admitting a WebSocket connection failed', (error as Error).stack);
      client.close(INTERNAL_ERROR, 'Internal Error');
      return null;
    });
    this.admissions.set(client, admission);
    return admission;
  }

  /** The connection once admitted; `null` if it was refused, has closed, or is unknown. */
  async admitted(client: WebSocket): Promise<Connection | null> {
    await this.admissions.get(client);
    return this.connections.get(client) ?? null;
  }

  /** Forgets a closed socket. Idempotent. */
  release(client: WebSocket): void {
    const connection = this.connections.get(client);
    if (!connection) return;
    clearInterval(connection.recheck);
    this.connections.delete(client);
    const sessionClients = this.bySession.get(connection.sessionId);
    sessionClients?.delete(client);
    if (sessionClients?.size === 0) this.bySession.delete(connection.sessionId);
  }

  /** Closes for a policy violation (e.g. message flooding). */
  closeForViolation(client: WebSocket, reason: string): void {
    client.close(POLICY_VIOLATION, reason);
    this.release(client);
  }

  /** Closes because the session ended — the web app goes back to the login page. */
  closeForEndedSession(client: WebSocket): void {
    client.close(WS_CLOSE_CODES.sessionEnded, 'Session ended');
    this.release(client);
  }

  onModuleDestroy(): void {
    this.signOuts?.unsubscribe();
    for (const client of this.connections.keys()) this.release(client); // deleting while iterating a Map is safe
  }

  private async check(client: WebSocket, request: IncomingMessage): Promise<Connection | null> {
    if (!isSameOrigin(request.headers)) {
      client.close(POLICY_VIOLATION, 'Origin not allowed');
      return null;
    }
    const result = await this.authenticate(client, request);
    // Closed meanwhile — by the client, or by the authenticator on a store failure (1011).
    if (client.readyState !== WebSocket.OPEN) return null;
    if (!result?.session) {
      client.close(WS_CLOSE_CODES.sessionEnded, 'Session required');
      return null;
    }
    const sessionId = result.session.id;
    const sessionClients = this.bySession.get(sessionId) ?? new Set<WebSocket>();
    if (sessionClients.size >= this.options.maxConnectionsPerSession) {
      client.close(POLICY_VIOLATION, 'Too many connections');
      return null;
    }
    const recheck = setInterval(() => void this.recheck(client), this.options.sessionRecheckMs);
    recheck.unref();
    const connection: Connection = {
      sessionId,
      userId: result.user.id,
      limiter: new MessageRateLimiter(this.options.messageLimit, this.options.messageWindowMs),
      recheck,
    };
    sessionClients.add(client);
    this.bySession.set(sessionId, sessionClients);
    this.connections.set(client, connection);
    return connection;
  }

  /** A token-family sign-out (no session id) concerns no socket: they all use session cookies. */
  private closeSignedOut(event: AuthenticationSignOutEvent): void {
    for (const [client, connection] of this.connections) {
      const ended = event.everywhere
        ? connection.userId === event.userId
        : connection.sessionId === event.sessionId;
      if (ended) this.closeForEndedSession(client); // deleting while iterating a Map is safe
    }
  }

  private async recheck(client: WebSocket): Promise<void> {
    try {
      const result = await this.authenticate(client);
      if (!this.connections.has(client)) return; // closed meanwhile
      if (!result) this.closeForEndedSession(client);
    } catch (error) {
      this.logger.error('Re-checking a WebSocket session failed', (error as Error).stack);
    }
  }

  /** `required: false`: the closing is ours, with our codes. The request is kept on the client. */
  private async authenticate(
    client: WebSocket,
    request?: IncomingMessage,
  ): Promise<AuthenticationResult | null> {
    const result = await this.wsAuth.authenticateConnection(client, request, { required: false });
    return result as AuthenticationResult | null;
  }
}
