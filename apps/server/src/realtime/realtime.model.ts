import type { LogsClose, LogsOpen, RealtimeTopic, ServerEventData } from '@homelab/shared';
import type { Observable } from 'rxjs';
import type { MessageRateLimiter } from './message-rate-limiter.js';

export interface Connection {
  readonly sessionId: string;
  readonly userId: string;
  readonly limiter: MessageRateLimiter;
  readonly recheck: NodeJS.Timeout;
}

export interface RealtimeOptions {
  /** Open sockets per session — one per browser tab, so a handful is plenty. */
  maxConnectionsPerSession: number;
  /** Client messages per connection within `windowMs`; beyond it they get a `rate_limited` error. */
  messageLimit: number;
  messageWindowMs: number;
  /** How often an open connection's session is checked again (besides on every message). */
  sessionRecheckMs: number;
}

/**
 * Where a topic's data comes from (system metrics, Docker, backups). Collects only while
 * `updates$` is subscribed: the registry subscribes when the first client subscribes (before that
 * client's snapshot) and unsubscribes when the last one leaves.
 */
export interface TopicSource<T extends RealtimeTopic = RealtimeTopic> {
  readonly topic: T;
  /** Current values plus history — sent to each new subscriber. */
  snapshot(): Promise<SnapshotData<T>>;
  /** Every update, while subscribed. Catches its own errors (one that slips through restarts it). */
  readonly updates$: Observable<UpdateData<T>>;
}

/**
 * - `allowed`: within the limit.
 * - `limited`: over it — the message is answered with a `rate_limited` error.
 * - `abusive`: twice over it — the client ignores the errors, so the connection is closed.
 */
export type RateDecision = 'allowed' | 'limited' | 'abusive';

/**
 * Per-client log streams (`logs:open` / `logs:close`). Unlike topics, each viewer has its own
 * stream: a specific container, from its own starting point.
 */
export interface LogStreamHandler {
  /** Throws a `RealtimeException` to refuse (e.g. `too_many_streams`). */
  open(client: RealtimeClient, request: LogsOpen): void;
  /** Idempotent. */
  close(client: RealtimeClient, request: LogsClose): void;
  /** A disconnected client: close all of its streams. */
  removeClient(client: RealtimeClient): void;
}

export type SnapshotData<T extends RealtimeTopic> = ServerEventData<`${T}:snapshot`>;

export type UpdateData<T extends RealtimeTopic> = ServerEventData<`${T}:update`>;

/** What sending needs from a socket — `ws`'s `WebSocket` fits; tests pass a fake. */
export interface RealtimeClient {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
}
