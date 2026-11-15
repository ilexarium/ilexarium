import {
  DestroyRef,
  DOCUMENT,
  effect,
  inject,
  InjectionToken,
  Service,
  signal,
} from '@angular/core';
import {
  type ClientMessage,
  REALTIME_PATH,
  type RealtimeTopic,
  type ServerMessage,
  serverMessageSchema,
  REALTIME_ERROR_CODES,
  WS_CLOSE_CODES,
} from '@ilex/shared';
import { firstValueFrom } from 'rxjs';
import { AuthApi } from '../auth/auth-api';
import { AuthStore } from '../auth/auth-store';
import {
  FIRST_RETRY_MS,
  HIDDEN_GRACE_MS,
  MAX_RETRY_MS,
  OPEN,
  RATE_LIMITED_RETRY_MS,
} from './realtime.constants';
import type { ConnectionStatus } from './realtime.model';

/** How sockets are made — tests swap in a fake. */
export const WEB_SOCKET_FACTORY = new InjectionToken<(url: string) => WebSocket>(
  'WEB_SOCKET_FACTORY',
  { providedIn: 'root', factory: () => (url: string) => new WebSocket(url) },
);

type Listener = (message: ServerMessage) => void;

/**
 * The app's one WebSocket (`/api/ws`). Features subscribe to topics; the service keeps the
 * socket and the server-side subscriptions in step with them:
 *
 * - **Reconnects** with backoff (1 s, doubling, at most 30 s) and re-subscribes, so each topic
 *   gets a fresh snapshot.
 * - **Closed with 4401** (session ended): asks the server who is signed in. Still signed in (a
 *   password change replaced this browser's session) → reconnects; otherwise → login.
 * - **Hidden tab:** after 10 s hidden, unsubscribes from everything, so the server stops
 *   collecting; subscribes again (fresh snapshots) when the tab is visible. Shown again sooner,
 *   nothing was sent.
 * - **Refused for too many messages:** a refused (un)subscribe would leave the server out of step,
 *   so the socket is replaced once the server's window has passed.
 * - **Sign-out:** closes the socket (nothing of the previous user remains).
 */
@Service()
export class RealtimeService {
  private readonly authStore = inject(AuthStore);
  private readonly authApi = inject(AuthApi);
  private readonly document = inject(DOCUMENT);
  private readonly createSocket = inject(WEB_SOCKET_FACTORY);

  private readonly listeners = new Map<RealtimeTopic, Set<Listener>>();
  private readonly _status = signal<ConnectionStatus>('offline');
  private socket: WebSocket | null = null;
  private wanted = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private hiddenTimer: ReturnType<typeof setTimeout> | null = null;
  /** The server has none of this socket's topics (unsubscribed while hidden). */
  private paused = false;

  readonly status = this._status.asReadonly();

  constructor() {
    effect(() => {
      if (!this.authStore.isAuthenticated()) this.disconnect();
    });
    const onVisibilityChange = () => (this.visible() ? this.shown() : this.hidden());
    this.document.addEventListener('visibilitychange', onVisibilityChange);
    inject(DestroyRef).onDestroy(() => {
      this.document.removeEventListener('visibilitychange', onVisibilityChange);
      this.disconnect();
    });
  }

  /** Opens the socket (idempotent); it then stays open, reconnecting, until sign-out. */
  connect(): void {
    if (this.wanted) return;
    this.wanted = true;
    this.attempt = 0;
    this.open();
  }

  disconnect(): void {
    this.wanted = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.clearHiddenTimer();
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000);
    this._status.set('offline');
  }

  /**
   * Calls `listener` with every message of `topic` — a snapshot first, then updates — until the
   * returned function is called. Several listeners share one server-side subscription.
   */
  subscribe(topic: RealtimeTopic, listener: Listener): () => void {
    let topicListeners = this.listeners.get(topic);
    if (!topicListeners) {
      topicListeners = new Set();
      this.listeners.set(topic, topicListeners);
    }
    topicListeners.add(listener);
    if (topicListeners.size === 1 && !this.paused) this.send('subscribe', topic);
    return () => {
      if (!topicListeners.delete(listener) || topicListeners.size > 0) return;
      this.listeners.delete(topic);
      if (!this.paused) this.send('unsubscribe', topic);
    };
  }

  private open(): void {
    this._status.set(this.attempt === 0 ? 'connecting' : 'reconnecting');
    const { protocol, host } = this.document.location;
    const socket = this.createSocket(
      `${protocol === 'https:' ? 'wss:' : 'ws:'}//${host}${REALTIME_PATH}`,
    );
    this.socket = socket;
    socket.onopen = () => {
      if (socket !== this.socket) return;
      this.attempt = 0;
      this._status.set('live');
      // A new socket has no topics on the server yet.
      this.paused = !this.visible();
      if (this.paused) this.clearHiddenTimer();
      else this.sendAll('subscribe');
    };
    socket.onmessage = (event: MessageEvent) => {
      if (socket === this.socket) this.dispatch(event.data);
    };
    socket.onclose = (event: CloseEvent) => {
      if (socket !== this.socket) return; // replaced or closed on purpose
      this.socket = null;
      if (!this.wanted) return;
      if (event.code === WS_CLOSE_CODES.sessionEnded) void this.checkSession();
      else this.retryLater();
    };
  }

  private retryLater(): void {
    this._status.set('reconnecting');
    const delay = Math.min(FIRST_RETRY_MS * 2 ** this.attempt, MAX_RETRY_MS);
    this.attempt++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.wanted) this.open();
    }, delay);
  }

  /** After a 4401: still signed in → try again (with backoff); signed out → login. */
  private async checkSession(): Promise<void> {
    this._status.set('reconnecting');
    try {
      const { user } = await firstValueFrom(this.authApi.me());
      if (!this.wanted) return;
      if (user) this.retryLater();
      else this.authStore.sessionExpired(); // signs out, which disconnects
    } catch {
      if (this.wanted) this.retryLater(); // server unreachable: keep trying
    }
  }

  private dispatch(raw: unknown): void {
    let message: ServerMessage;
    try {
      message = serverMessageSchema.parse(JSON.parse(String(raw)));
    } catch {
      console.warn('Ignored an invalid realtime message');
      return;
    }
    if (message.event === 'error') {
      console.warn(`Realtime error: ${message.data.code} — ${message.data.message}`);
      if (message.data.code === REALTIME_ERROR_CODES.rateLimited) this.replaceLater();
      return;
    }
    const topic = message.event.split(':')[0] as RealtimeTopic;
    for (const listener of this.listeners.get(topic) ?? []) listener(message);
  }

  private hidden(): void {
    if (this.hiddenTimer || this.paused) return;
    this.hiddenTimer = setTimeout(() => {
      this.hiddenTimer = null;
      this.paused = true;
      this.sendAll('unsubscribe');
    }, HIDDEN_GRACE_MS);
  }

  private shown(): void {
    if (this.hiddenTimer) return this.clearHiddenTimer();
    if (!this.paused) return;
    this.paused = false;
    this.sendAll('subscribe');
  }

  private clearHiddenTimer(): void {
    if (this.hiddenTimer) clearTimeout(this.hiddenTimer);
    this.hiddenTimer = null;
  }

  /** Closes this socket at once and opens a fresh one after the server's window. */
  private replaceLater(): void {
    const socket = this.socket;
    if (!socket || !this.wanted) return;
    this.socket = null;
    socket.close(1000);
    this._status.set('reconnecting');
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.wanted) this.open();
    }, RATE_LIMITED_RETRY_MS);
  }

  private sendAll(event: 'subscribe' | 'unsubscribe'): void {
    for (const topic of this.listeners.keys()) this.send(event, topic);
  }

  private send(event: 'subscribe' | 'unsubscribe', topic: RealtimeTopic): void {
    if (this.socket?.readyState === OPEN) {
      this.socket.send(JSON.stringify({ event, data: { topic } } satisfies ClientMessage));
    }
  }

  private visible(): boolean {
    return this.document.visibilityState !== 'hidden';
  }
}
