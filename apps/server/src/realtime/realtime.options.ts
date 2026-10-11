/** Larger frames are refused by `ws` itself (close 1009); client messages are a few dozen bytes. */
export const MAX_MESSAGE_BYTES = 4096;

export interface RealtimeOptions {
  /** Open sockets per session — one per browser tab, so a handful is plenty. */
  maxConnectionsPerSession: number;
  /** Client messages per connection within `windowMs`; beyond it they get a `rate_limited` error. */
  messageLimit: number;
  messageWindowMs: number;
  /** How often an open connection's session is checked again (besides on every message). */
  sessionRecheckMs: number;
}

export const REALTIME_OPTIONS = Symbol('REALTIME_OPTIONS');

export const DEFAULT_REALTIME_OPTIONS: RealtimeOptions = {
  maxConnectionsPerSession: 5,
  messageLimit: 20,
  messageWindowMs: 10_000,
  sessionRecheckMs: 30_000,
};
