import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import {
  type ContainerState,
  LOG_LIMITS,
  type LogLine,
  type LogsClose,
  type LogsEndReason,
  type LogsOpen,
  type ServerMessage,
} from '@homelab/shared';
import { WebSocket } from 'ws';
import { ContainerLogsError, DockerService } from '../docker/docker.service.js';
import { normaliseTimestamp } from '../docker/log-lines.js';
import { RealtimeLogStreams } from '../realtime/realtime-log-streams.js';
import { canSend, RealtimeException, sendMessage } from '../realtime/realtime-messages.js';
import type { LogStreamHandler, RealtimeClient } from '../realtime/realtime.model.js';

/** A batch holds at most this many lines and bytes; the rest of a flood is counted as skipped. */
export const MAX_BATCH_LINES = 500;
export const MAX_BATCH_BYTES = 256 * 1024;
/** Before re-opening a stream Docker ended while the container still runs. */
export const REOPEN_DELAY_MS = 1_000;
const STILL_RUNNING: ContainerState[] = ['running', 'restarting'];

/** One viewer's stream of one container. */
interface Stream {
  readonly container: string;
  readonly controller: AbortController;
  pending: LogLine[];
  pendingBytes: number;
  /** Lines dropped after the last pending (or sent) one. */
  skipped: number;
  /** The last line received: where a re-opened stream continues. */
  lastAt: string | null;
  lastFlush: number;
  timer: NodeJS.Timeout | null;
}

/**
 * Container logs over the WebSocket: one Docker stream per open viewer (`logs:open`), closed on
 * `logs:close`, on disconnect (which is also how a sign-out ends them) and on shutdown.
 *
 * - **Batches:** lines go out at most every `LOG_LIMITS.batchIntervalMs`, at most
 *   `MAX_BATCH_LINES` / `MAX_BATCH_BYTES` each; a flood beyond that — or a client that isn't
 *   keeping up — becomes a `skipped` count, so server memory stays bounded.
 * - **End:** Docker ends a follow stream when the container stops, is removed, or (through the
 *   proxy) after an hour without output. The container's state tells which: still running →
 *   re-opened quietly where it left off; stopped → `logs:end stopped`; gone → `removed`.
 */
@Injectable()
export class ContainerLogStreams implements LogStreamHandler, OnModuleDestroy {
  private readonly logger = new Logger(ContainerLogStreams.name);
  private readonly clients = new Map<RealtimeClient, Map<string, Stream>>();

  constructor(
    private readonly docker: DockerService,
    logStreams: RealtimeLogStreams,
  ) {
    logStreams.register(this);
  }

  /** Opening a container that is already open restarts its stream (a viewer resuming). */
  open(client: RealtimeClient, { container, tail, since }: LogsOpen): void {
    const streams = this.clients.get(client) ?? new Map<string, Stream>();
    const existing = streams.get(container);
    if (!existing && streams.size >= LOG_LIMITS.maxStreamsPerConnection) {
      throw RealtimeException.tooManyStreams();
    }
    if (existing) this.stop(existing);
    const stream: Stream = {
      container,
      controller: new AbortController(),
      pending: [],
      pendingBytes: 0,
      skipped: 0,
      lastAt: null,
      lastFlush: 0,
      timer: null,
    };
    streams.set(container, stream);
    this.clients.set(client, streams);
    void this.run(client, stream, since === undefined ? { tail } : { tail, since });
  }

  close(client: RealtimeClient, { container }: LogsClose): void {
    const stream = this.clients.get(client)?.get(container);
    if (stream) this.remove(client, stream);
  }

  removeClient(client: RealtimeClient): void {
    for (const stream of this.clients.get(client)?.values() ?? []) this.stop(stream);
    this.clients.delete(client);
  }

  /** Open Docker streams, over all clients. */
  get openCount(): number {
    let count = 0;
    for (const streams of this.clients.values()) count += streams.size;
    return count;
  }

  onModuleDestroy(): void {
    for (const client of this.clients.keys()) this.removeClient(client); // deleting while iterating a Map is safe
  }

  private async run(
    client: RealtimeClient,
    stream: Stream,
    first: { tail: number; since?: string },
  ): Promise<void> {
    const { signal } = stream.controller;
    const openedAt = normaliseTimestamp(new Date().toISOString())!;
    let request: { tail?: number; since?: string } = first;
    let reopened = false;
    for (;;) {
      let reason: LogsEndReason | null = null;
      try {
        for await (const line of this.docker.containerLogs(stream.container, request, signal)) {
          if (signal.aborted) return;
          this.push(client, stream, line);
        }
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof ContainerLogsError) {
          // Not found on a re-open: it was there a moment ago.
          reason = error.reason === 'not_found' && reopened ? 'removed' : error.reason;
        } else {
          this.logger.warn(`Logs of ${stream.container} failed: ${(error as Error).message}`);
          reason = 'error';
        }
      }
      if (signal.aborted) return;
      if (reason === null) {
        const state = await this.docker.containerState(stream.container).catch(() => undefined);
        if (signal.aborted) return;
        if (state && STILL_RUNNING.includes(state)) {
          if (!(await wait(REOPEN_DELAY_MS, signal))) return;
          // Everything after the last line seen (or since this viewer opened, if none yet).
          request = { since: stream.lastAt ?? openedAt };
          reopened = true;
          continue;
        }
        reason = state === null ? 'removed' : state === undefined ? 'error' : 'stopped';
      }
      this.end(client, stream, reason);
      return;
    }
  }

  private push(client: RealtimeClient, stream: Stream, line: LogLine): void {
    stream.lastAt = line.at;
    const bytes = Buffer.byteLength(line.text);
    const full =
      stream.pending.length >= MAX_BATCH_LINES ||
      (stream.pending.length > 0 && stream.pendingBytes + bytes > MAX_BATCH_BYTES);
    // Once lines are skipped, later ones are too until the next batch: `skipped` means "after".
    if (full || stream.skipped > 0) {
      stream.skipped++;
    } else {
      stream.pending.push(line);
      stream.pendingBytes += bytes;
    }
    this.schedule(client, stream);
  }

  private schedule(client: RealtimeClient, stream: Stream): void {
    if (stream.timer) return;
    const delay = Math.max(0, stream.lastFlush + LOG_LIMITS.batchIntervalMs - Date.now());
    stream.timer = setTimeout(() => {
      stream.timer = null;
      this.flush(client, stream);
    }, delay);
  }

  private flush(client: RealtimeClient, stream: Stream): void {
    if (stream.pending.length === 0 && stream.skipped === 0) return;
    if (!canSend(client)) {
      if (client.readyState !== WebSocket.OPEN) return; // closing: the disconnect cleans up
      // Backed up: what's pending is dropped too, and the count goes out once it catches up.
      stream.skipped += stream.pending.length;
      stream.pending = [];
      stream.pendingBytes = 0;
      stream.lastFlush = Date.now();
      this.schedule(client, stream);
      return;
    }
    sendMessage(client, {
      event: 'logs:lines',
      data: {
        container: stream.container,
        lines: stream.pending,
        ...(stream.skipped > 0 && { skipped: stream.skipped }),
      },
    });
    stream.pending = [];
    stream.pendingBytes = 0;
    stream.skipped = 0;
    stream.lastFlush = Date.now();
  }

  /** The last lines, then `logs:end` — even to a backed-up client, so the page isn't left waiting. */
  private end(client: RealtimeClient, stream: Stream, reason: LogsEndReason): void {
    if (stream.timer) clearTimeout(stream.timer);
    stream.timer = null;
    this.flush(client, stream);
    if (client.readyState === WebSocket.OPEN) {
      const message: ServerMessage = {
        event: 'logs:end',
        data: { container: stream.container, reason },
      };
      client.send(JSON.stringify(message));
    }
    this.remove(client, stream);
  }

  private remove(client: RealtimeClient, stream: Stream): void {
    this.stop(stream);
    const streams = this.clients.get(client);
    if (streams?.get(stream.container) !== stream) return; // already replaced by a re-open
    streams.delete(stream.container);
    if (streams.size === 0) this.clients.delete(client);
  }

  private stop(stream: Stream): void {
    stream.controller.abort();
    if (stream.timer) clearTimeout(stream.timer);
    stream.timer = null;
    stream.pending = [];
  }
}

/** Resolves true after `ms`, or false as soon as `signal` aborts. */
function wait(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
