import { effect, inject, untracked } from '@angular/core';
import { patchState, signalStore, withHooks, withMethods, withState } from '@ngrx/signals';
import { type ClientMessage, LOG_LIMITS, type ServerMessage } from '@homelab/shared';
import { AuthStore } from '../../../core/auth/auth-store';
import { RealtimeService } from '../../../core/realtime/realtime-service';
import type { RealtimeStream } from '../../../core/realtime/realtime.model';
import type { LogEntry, LogStreamState } from '../containers.model';

/** No message this long after opening: the container has no output (yet). */
export const QUIET_MS = 1_000;

interface LogsPageState {
  entries: LogEntry[];
  state: LogStreamState;
}

const initialState: LogsPageState = { entries: [], state: { status: 'idle' } };

/**
 * The logs page's data — one container's logs, live — provided by the page and gone with it:
 *
 * - the last `tail` lines first, then new ones; at most `LOG_LIMITS.maxLinesInView` kept;
 * - **resumes** after a dropped connection, and when a hidden tab is shown again, from the last
 *   line it has (`since`) — lines are neither repeated nor missed;
 * - closed on `close()`, when the page goes away, and on sign-out (its lines are cleared).
 *
 * A per-viewer stream (`RealtimeService.attach()`), not a topic: each viewer its own container
 * and starting point.
 */
export const LogsPageStore = signalStore(
  withState<LogsPageState>(initialState),
  withMethods((store, realtime = inject(RealtimeService)) => {
    // Not state: what the stream needs to resume, and its plumbing.
    let container: string | null = null;
    let tail: number = LOG_LIMITS.defaultTail;
    let lastAt: string | null = null;
    let nextId = 0;
    let detach: (() => void) | null = null;
    let send: ((message: ClientMessage) => void) | null = null;
    let quietTimer: ReturnType<typeof setTimeout> | null = null;

    /** Open on the server: requested and not ended. */
    const active = () => {
      const { status } = store.state();
      return container !== null && (status === 'loading' || status === 'live');
    };

    const clearQuietTimer = () => {
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = null;
    };

    const resume = (sender: (message: ClientMessage) => void) => {
      send = sender;
      if (!active()) return;
      sender({
        event: 'logs:open',
        // Resuming: everything after the last line, as much as the server gives at once.
        data: lastAt
          ? { container: container!, tail: LOG_LIMITS.maxTail, since: lastAt }
          : { container: container!, tail },
      });
      if (store.state().status === 'loading') {
        clearQuietTimer();
        quietTimer = setTimeout(() => {
          quietTimer = null;
          if (store.state().status === 'loading') patchState(store, { state: { status: 'live' } });
        }, QUIET_MS);
      }
    };

    const receive = (message: ServerMessage) => {
      if (message.event === 'error') {
        // The only refusal of a `logs:open`; it can only be this stream's while nothing has come.
        if (message.data.code === 'too_many_streams' && store.state().status === 'loading') {
          clearQuietTimer();
          patchState(store, { state: { status: 'refused' } });
        }
        return;
      }
      if (message.event !== 'logs:lines' && message.event !== 'logs:end') return;
      if (message.data.container !== container || !active()) return;

      if (message.event === 'logs:end') {
        clearQuietTimer();
        patchState(store, { state: { status: 'ended', reason: message.data.reason } });
        return;
      }
      const added: LogEntry[] = [];
      for (const line of message.data.lines) {
        if (lastAt !== null && line.at <= lastAt) continue; // already have it
        lastAt = line.at;
        added.push({ kind: 'line', id: nextId++, ...line });
      }
      if (message.data.skipped) {
        added.push({ kind: 'skipped', id: nextId++, count: message.data.skipped });
      }
      if (added.length > 0) {
        patchState(store, {
          entries: [...store.entries(), ...added].slice(-LOG_LIMITS.maxLinesInView),
        });
      }
      clearQuietTimer();
      patchState(store, { state: { status: 'live' } });
    };

    const stream: RealtimeStream = {
      resume,
      pause: (sender) => {
        if (active()) sender({ event: 'logs:close', data: { container: container! } });
      },
      receive,
    };

    /** Stops the stream and forgets its lines. Idempotent. */
    const close = () => {
      if (active()) send?.({ event: 'logs:close', data: { container: container! } });
      detach?.();
      detach = null;
      send = null;
      clearQuietTimer();
      container = null;
      lastAt = null;
      patchState(store, initialState);
    };

    return {
      /** Starts (or restarts) the stream of `name`, from its last `tailLines` lines. */
      open(name: string, tailLines: number = LOG_LIMITS.defaultTail): void {
        close();
        container = name;
        tail = tailLines;
        patchState(store, { state: { status: 'loading' } });
        detach = realtime.attach(stream);
      },
      close,
    };
  }),
  withHooks((store, auth = inject(AuthStore)) => ({
    onInit() {
      effect(() => {
        // Untracked: close() reads and sets the state, which must not re-run this effect.
        if (!auth.isAuthenticated()) untracked(() => store.close());
      });
    },
    onDestroy() {
      store.close();
    },
  })),
);
