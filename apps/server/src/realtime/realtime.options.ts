import type { RealtimeOptions } from './realtime.model.js';
/** Larger frames are refused by `ws` itself (close 1009); client messages are a few dozen bytes. */
export const MAX_MESSAGE_BYTES = 4096;

export const REALTIME_OPTIONS = Symbol('REALTIME_OPTIONS');

export const DEFAULT_REALTIME_OPTIONS: RealtimeOptions = {
  maxConnectionsPerSession: 5,
  messageLimit: 20,
  messageWindowMs: 10_000,
  sessionRecheckMs: 30_000,
};
