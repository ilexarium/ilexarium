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

/** RFC 6455 §7.4.1. */
export const POLICY_VIOLATION = 1008;
export const INTERNAL_ERROR = 1011;

/** Above this much unsent data the client isn't keeping up: updates are skipped, not queued. */
export const MAX_BUFFERED_BYTES = 1024 * 1024;

/** A source whose updates failed is subscribed again after this long. */
export const SOURCE_RETRY_MS = 5_000;
