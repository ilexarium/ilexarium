import type { ContainerState } from '@laris/shared';

/** What `EventSource` waits before reconnecting (its `retry`). */
export const RETRY_MS = 1_000;
/** A response ends after this long; the reconnect checks the session again. */
export const MAX_RESPONSE_MS = 15 * 60_000;
/** A comment line this often keeps a quiet stream's connection open and finds dead ones. */
export const HEARTBEAT_MS = 30_000;
/** At most this many lines per `lines` event; a burst becomes several. */
export const MAX_BATCH_LINES = 500;
/**
 * Docker ended the stream and the container isn't running: asked again after this long, since
 * a restart (stop, then start) looks stopped for a moment.
 */
export const STOP_GRACE_MS = 1_500;
/** Docker ended the stream but the container is in one of these: the response just ends. */
export const STILL_RUNNING: readonly ContainerState[] = ['running', 'restarting'];
