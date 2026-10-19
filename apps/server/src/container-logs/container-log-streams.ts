import { setTimeout as sleep } from 'node:timers/promises';
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { AuthenticationEvents } from '@nestjs/authentication';
import type { Response } from 'express';
import type { Subscription } from 'rxjs';
import {
  type ContainerState,
  LOG_LIMITS,
  LOGS_EVENTS,
  type LogLine,
  type LogsEndReason,
} from '@homelab/shared';
import { ContainerLogsError, DockerService } from '../docker/docker.service.js';
import {
  HEARTBEAT_MS,
  MAX_BATCH_LINES,
  MAX_RESPONSE_MS,
  RETRY_MS,
  STILL_RUNNING,
  STOP_GRACE_MS,
} from './container-logs.constants.js';
import type { LogsRequest, LogViewer } from './container-logs.model.js';
import { SseResponse } from './sse-response.js';

interface Stream {
  readonly viewer: LogViewer;
  readonly controller: AbortController;
}

/**
 * Container logs as Server-Sent Events: one response per log view, one Docker stream behind it.
 *
 * - **Backpressure:** the next line is read from Docker only once the browser takes what was
 *   written, so a slow viewer slows the reading (Docker keeps the lines in its log file).
 * - **End:** Docker ends a follow stream when the container stops, is removed, or (through the
 *   proxy) after an hour without output — and when it restarts. The container's state tells
 *   which: still running → the response just ends and `EventSource` reconnects, continuing
 *   after its `Last-Event-ID`; otherwise asked again after `STOP_GRACE_MS` (a restart is running
 *   again by then): stopped → `end stopped`; gone → `removed`. Every outcome is an event: `EventSource` can't
 *   read an error response.
 * - **Limits:** `LOG_LIMITS.maxStreamsPerSession` new views per sign-in (`end too_many` beyond;
 *   a resumed view isn't refused, its dropped connection may still be counted); each
 *   response ends after `MAX_RESPONSE_MS`, so the reconnect checks the session again. Sign-out
 *   ends the session's streams at once — log lines can hold secrets.
 */
@Injectable()
export class ContainerLogStreams implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ContainerLogStreams.name);
  private readonly streams = new Set<Stream>();
  private signOuts?: Subscription;

  constructor(
    private readonly docker: DockerService,
    private readonly authEvents: AuthenticationEvents,
  ) {}

  onModuleInit(): void {
    this.signOuts = this.authEvents.events$.subscribe((event) => {
      if (event.type !== 'sign-out') return;
      for (const stream of this.streams) {
        const ended = event.everywhere
          ? stream.viewer.userId === event.userId
          : stream.viewer.sessionId === event.sessionId;
        if (ended) stream.controller.abort();
      }
    });
  }

  onModuleDestroy(): void {
    this.signOuts?.unsubscribe();
    for (const stream of this.streams) stream.controller.abort();
  }

  /** Open Docker streams, over all viewers. */
  get openCount(): number {
    return this.streams.size;
  }

  /** Answers the request until the stream ends, the browser leaves, or the response's time is up. */
  async serve(res: Response, request: LogsRequest, viewer: LogViewer): Promise<void> {
    const controller = new AbortController();
    const { signal } = controller;
    res.on('close', () => controller.abort());
    const sse = new SseResponse(res, signal);
    sse.start(RETRY_MS);

    // Counted and added before the first await, so parallel requests can't all pass. Only new
    // views are refused: a reconnect's old connection may not have been noticed as gone yet.
    const open = [...this.streams].filter((s) => s.viewer.sessionId === viewer.sessionId).length;
    if (request.since === undefined && open >= LOG_LIMITS.maxStreamsPerSession) {
      sse.event(LOGS_EVENTS.end, { reason: 'too_many' });
      sse.end();
      return;
    }
    const stream: Stream = { viewer, controller };
    this.streams.add(stream);
    const expiry = setTimeout(() => controller.abort(), MAX_RESPONSE_MS);
    const heartbeat = setInterval(() => {
      if (!sse.backedUp) sse.comment();
    }, HEARTBEAT_MS);
    try {
      const reason = await this.follow(sse, request, signal);
      if (reason && !signal.aborted) sse.event(LOGS_EVENTS.end, { reason });
    } finally {
      clearTimeout(expiry);
      clearInterval(heartbeat);
      this.streams.delete(stream);
      sse.end();
    }
  }

  /** Why the stream is over, or null when the response should just end (and be reconnected). */
  private async follow(
    sse: SseResponse,
    { name, tail, since }: LogsRequest,
    signal: AbortSignal,
  ): Promise<LogsEndReason | null> {
    // Resuming: everything after the last line, as much as Docker gives at once.
    const options = since === undefined ? { tail } : { tail: LOG_LIMITS.maxTail, since };
    try {
      await this.send(sse, this.docker.containerLogs(name, options, signal), signal);
    } catch (error) {
      if (signal.aborted) return null;
      if (error instanceof ContainerLogsError) {
        // Not found when resuming: it was there a moment ago.
        return error.reason === 'not_found' && since !== undefined ? 'removed' : error.reason;
      }
      this.logger.warn(`Logs of ${name} failed: ${(error as Error).message}`);
      return 'error';
    }
    if (signal.aborted) return null;
    let state = await this.state(name);
    if (!(state && STILL_RUNNING.includes(state))) {
      // A restart ends the stream too, and the container is `exited` until it starts again.
      if (!(await sleep(STOP_GRACE_MS, true, { signal }).catch(() => false))) return null;
      state = await this.state(name);
    }
    if (signal.aborted || (state && STILL_RUNNING.includes(state))) return null;
    return state === null ? 'removed' : state === undefined ? 'error' : 'stopped';
  }

  /** The container's state; null if it's gone, undefined if Docker didn't answer. */
  private state(name: string): Promise<ContainerState | null | undefined> {
    return this.docker.containerState(name).catch(() => undefined);
  }

  /**
   * Lines go out in batches: those Docker delivered together (one chunk) become one event, the
   * last line's time its id — what the browser resumes from.
   */
  private async send(
    sse: SseResponse,
    lines: AsyncIterable<LogLine>,
    signal: AbortSignal,
  ): Promise<void> {
    let batch: LogLine[] = [];
    let pending: NodeJS.Immediate | null = null;
    const flush = () => {
      if (pending) clearImmediate(pending);
      pending = null;
      if (batch.length === 0 || signal.aborted) return;
      sse.event(LOGS_EVENTS.lines, { lines: batch }, batch.at(-1)!.at);
      batch = [];
    };
    try {
      for await (const line of lines) {
        batch.push(line);
        if (batch.length >= MAX_BATCH_LINES) flush();
        else pending ??= setImmediate(flush);
        if (sse.backedUp) await sse.drained();
        if (signal.aborted) return;
      }
    } finally {
      flush();
    }
  }
}
