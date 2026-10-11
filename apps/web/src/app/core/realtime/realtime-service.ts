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
  REALTIME_PATH,
  type RealtimeTopic,
  type ServerMessage,
  serverMessageSchema,
  WS_CLOSE_CODES,
} from '@homelab/shared';
import { AuthApi } from '../auth/auth-api';
import { AuthStore } from '../auth/auth-store';

/**
 * `offline`: not connected and not trying (signed out). `connecting`: the first attempt.
 * `live`: connected. `reconnecting`: the connection dropped; trying again.
 */
export type ConnectionStatus = 'offline' | 'connecting' | 'live' | 'reconnecting';

/** How sockets are made — tests swap in a fake. */
export const WEB_SOCKET_FACTORY = new InjectionToken<(url: string) => WebSocket>(
  'WEB_SOCKET_FACTORY',
  { providedIn: 'root', factory: () => (url: string) => new WebSocket(url) },
);

/** `WebSocket.OPEN`, without needing the global (tests use a fake socket). */
const OPEN = 1;

export const FIRST_RETRY_MS = 1_000;
export const MAX_RETRY_MS = 30_000;

type Listener = (message: ServerMessage) => void;

/**
 * The app's one WebSocket (`/api/ws`). Features subscribe to topics; the service keeps the
 * socket and the server-side subscriptions in step with them:
 *
 * - **Reconnects** with backoff (1 s, doubling, at most 30 s) and re-subscribes, so each topic
 *   gets a fresh snapshot.
 * - **Closed with 4401** (session ended): asks the server who is signed in. Still signed in (a
 *   password change replaced this browser's session) → reconnects; otherwise → login.
 * - **Hidden tab:** unsubscribes from everything, so the server stops collecting; subscribes
 *   again (fresh snapshots) when the tab is visible.
 * - **Sign-out:** closes the socket (nothing of the previous user remains).
 */
@Service()
export class RealtimeService {
  private readonly auth = inject(AuthStore);
  private readonly authApi = inject(AuthApi);
  private readonly document = inject(DOCUMENT);
  private readonly createSocket = inject(WEB_SOCKET_FACTORY);

  private readonly listeners = new Map<RealtimeTopic, Set<Listener>>();
  private readonly _status = signal<ConnectionStatus>('offline');
  private socket: WebSocket | null = null;
  private wanted = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  readonly status = this._status.asReadonly();

  constructor() {
    effect(() => {
      if (!this.auth.isAuthenticated()) this.disconnect();
    });
    const onVisibilityChange = () => this.sendAll(this.visible() ? 'subscribe' : 'unsubscribe');
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
    if (topicListeners.size === 1 && this.visible()) this.send('subscribe', topic);
    return () => {
      if (!topicListeners.delete(listener) || topicListeners.size > 0) return;
      this.listeners.delete(topic);
      if (this.visible()) this.send('unsubscribe', topic);
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
      if (this.visible()) this.sendAll('subscribe');
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
      const { user } = await this.authApi.me();
      if (!this.wanted) return;
      if (user) this.retryLater();
      else this.auth.sessionExpired(); // signs out, which disconnects
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
      return;
    }
    const topic = message.event.split(':')[0] as RealtimeTopic;
    for (const listener of this.listeners.get(topic) ?? []) listener(message);
  }

  private sendAll(event: 'subscribe' | 'unsubscribe'): void {
    for (const topic of this.listeners.keys()) this.send(event, topic);
  }

  private send(event: 'subscribe' | 'unsubscribe', topic: RealtimeTopic): void {
    if (this.socket?.readyState === OPEN) {
      this.socket.send(JSON.stringify({ event, data: { topic } }));
    }
  }

  private visible(): boolean {
    return this.document.visibilityState !== 'hidden';
  }
}
