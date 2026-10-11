import { Injectable } from '@nestjs/common';
import type { LogsClose, LogsOpen } from '@homelab/shared';
import type { LogStreamHandler, RealtimeClient } from './realtime.model.js';

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
