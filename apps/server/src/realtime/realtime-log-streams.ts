import { Injectable } from '@nestjs/common';
import type { LogsClose, LogsOpen } from '@homelab/shared';
import type { RealtimeClient } from './realtime-messages.js';

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

/**
 * Where the gateway hands log messages to — the container-logs feature registers itself here,
 * like a `TopicSource` with `RealtimeSubscriptions`, so this module needs nothing of Docker.
 */
@Injectable()
export class RealtimeLogStreams {
  private handler: LogStreamHandler | null = null;

  register(handler: LogStreamHandler): void {
    if (this.handler) throw new Error('A log stream handler is already registered');
    this.handler = handler;
  }

  open(client: RealtimeClient, request: LogsOpen): void {
    this.handler?.open(client, request);
  }

  close(client: RealtimeClient, request: LogsClose): void {
    this.handler?.close(client, request);
  }

  removeClient(client: RealtimeClient): void {
    this.handler?.removeClient(client);
  }
}
