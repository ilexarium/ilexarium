import { DestroyRef, effect, inject, Injectable, signal, untracked } from '@angular/core';
import {
  type ClientMessage,
  LOG_LIMITS,
  type LogLine,
  type LogsEndReason,
  type ServerMessage,
} from '@homelab/shared';
import { AuthStore } from '../../../core/auth/auth-store';
import { type RealtimeStream, RealtimeService } from '../../../core/realtime/realtime-service';

/** A log line, or a marker for lines the server skipped in a flood. `id` is unique per stream. */
export type LogEntry =
  ({ kind: 'line'; id: number } & LogLine) | { kind: 'skipped'; id: number; count: number };

/**
 * - `idle`: not opened. `loading`: waiting for the first lines.
 * - `live`: following (possibly no output yet).
 * - `ended`: the server ended the stream — the container stopped, was removed, … (`reason`).
 * - `refused`: too many log views open on this connection.
 */
export type LogStreamState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'live' }
  | { status: 'ended'; reason: LogsEndReason }
  | { status: 'refused' };

/** No message this long after opening: the container has no output (yet). */
export const QUIET_MS = 1_000;

/**
 * One container's logs, live, for the page that provides it (`providers: [LogStream]`):
 *
 * - the last `tail` lines first, then new ones; at most `LOG_LIMITS.maxLinesInView` kept;
 * - **resumes** after a dropped connection, and when a hidden tab is shown again, from the last
 *   line it has (`since`) — lines are neither repeated nor missed;
 * - closed on `close()`, when the page goes away, and on sign-out (its lines are cleared).
 */
@Injectable()
export class LogStream {
  private readonly realtime = inject(RealtimeService);
  private readonly _entries = signal<LogEntry[]>([]);
  private readonly _state = signal<LogStreamState>({ status: 'idle' });

  private container: string | null = null;
  private tail: number = LOG_LIMITS.defaultTail;
  private lastAt: string | null = null;
  private nextId = 0;
  private detach: (() => void) | null = null;
  private send: ((message: ClientMessage) => void) | null = null;
  private quietTimer: ReturnType<typeof setTimeout> | null = null;

  readonly entries = this._entries.asReadonly();
  readonly state = this._state.asReadonly();

  private readonly stream: RealtimeStream = {
    resume: (send) => this.resume(send),
    pause: (send) => {
      if (this.active()) send({ event: 'logs:close', data: { container: this.container! } });
    },
    receive: (message) => this.receive(message),
  };

  constructor() {
    const auth = inject(AuthStore);
    effect(() => {
      // Untracked: close() reads and sets the state, which must not re-run this effect.
      if (!auth.isAuthenticated()) untracked(() => this.close());
    });
    inject(DestroyRef).onDestroy(() => this.close());
  }

  /** Starts (or restarts) the stream of `container`, from its last `tail` lines. */
  open(container: string, tail: number = LOG_LIMITS.defaultTail): void {
    this.close();
    this.container = container;
    this.tail = tail;
    this._state.set({ status: 'loading' });
    this.detach = this.realtime.attach(this.stream);
  }

  /** Stops the stream and forgets its lines. Idempotent. */
  close(): void {
    if (this.active()) this.send?.({ event: 'logs:close', data: { container: this.container! } });
    this.detach?.();
    this.detach = null;
    this.send = null;
    this.clearQuietTimer();
    this.container = null;
    this.lastAt = null;
    this._entries.set([]);
    this._state.set({ status: 'idle' });
  }

  /** Open on the server: requested and not ended. */
  private active(): boolean {
    const { status } = this._state();
    return this.container !== null && (status === 'loading' || status === 'live');
  }

  private resume(send: (message: ClientMessage) => void): void {
    this.send = send;
    if (!this.active()) return;
    const container = this.container!;
    send({
      event: 'logs:open',
      // Resuming: everything after the last line, as much as the server gives at once.
      data: this.lastAt
        ? { container, tail: LOG_LIMITS.maxTail, since: this.lastAt }
        : { container, tail: this.tail },
    });
    if (this._state().status === 'loading') {
      this.clearQuietTimer();
      this.quietTimer = setTimeout(() => {
        this.quietTimer = null;
        if (this._state().status === 'loading') this._state.set({ status: 'live' });
      }, QUIET_MS);
    }
  }

  private receive(message: ServerMessage): void {
    if (message.event === 'error') {
      // The only refusal of a `logs:open`; it can only be this stream's while nothing has come.
      if (message.data.code === 'too_many_streams' && this._state().status === 'loading') {
        this.clearQuietTimer();
        this._state.set({ status: 'refused' });
      }
      return;
    }
    if (message.event !== 'logs:lines' && message.event !== 'logs:end') return;
    if (message.data.container !== this.container || !this.active()) return;

    if (message.event === 'logs:end') {
      this.clearQuietTimer();
      this._state.set({ status: 'ended', reason: message.data.reason });
      return;
    }
    const added: LogEntry[] = [];
    for (const line of message.data.lines) {
      if (this.lastAt !== null && line.at <= this.lastAt) continue; // already have it
      this.lastAt = line.at;
      added.push({ kind: 'line', id: this.nextId++, ...line });
    }
    if (message.data.skipped) {
      added.push({ kind: 'skipped', id: this.nextId++, count: message.data.skipped });
    }
    if (added.length > 0) {
      this._entries.update((entries) => [...entries, ...added].slice(-LOG_LIMITS.maxLinesInView));
    }
    this.clearQuietTimer();
    this._state.set({ status: 'live' });
  }

  private clearQuietTimer(): void {
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = null;
  }
}
