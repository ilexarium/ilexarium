import { DestroyRef, DOCUMENT, effect, inject, InjectionToken, untracked } from '@angular/core';
import { patchState, signalStore, withHooks, withMethods, withState } from '@ngrx/signals';
import {
  containerLogsPath,
  LOG_LIMITS,
  LOGS_EVENTS,
  logsEndSchema,
  logsLinesSchema,
} from '@ilex/shared';
import { AuthStore } from '../../../core/auth/auth-store';
import type { LogEntry, LogStreamState } from '../containers.model';
import { EVENT_SOURCE_CLOSED, QUIET_MS } from './logs-page-store.constants';

/** How event streams are opened — tests swap in a fake. */
export const EVENT_SOURCE_FACTORY = new InjectionToken<(url: string) => EventSource>(
  'EVENT_SOURCE_FACTORY',
  { providedIn: 'root', factory: () => (url: string) => new EventSource(url) },
);

interface LogsPageState {
  entries: LogEntry[];
  state: LogStreamState;
}

const initialState: LogsPageState = { entries: [], state: { status: 'idle' } };

/**
 * Closed on `close()`, when the page goes away, and on sign-out — its lines cleared.
 * `EventSource` resumes a dropped connection by itself, from its last event id; a hidden tab is
 * closed and reopened with `since` when shown again. A flood lands in at most one update per frame.
 */
export const LogsPageStore = signalStore(
  withState<LogsPageState>(initialState),
  withMethods(
    (store, eventSourceFactory = inject(EVENT_SOURCE_FACTORY), document = inject(DOCUMENT)) => {
      // Not state: what the stream needs to resume, and its plumbing.
      let container: string | null = null;
      let tail: number = LOG_LIMITS.defaultTail;
      /** The last line's time: where a reopened stream continues. */
      let lastId: string | null = null;
      let nextId = 0;
      let source: EventSource | null = null;
      let quietTimer: ReturnType<typeof setTimeout> | null = null;
      let arrived: LogEntry[] = [];
      let frame: number | null = null;

      /** Following: opened and not ended. */
      const active = () => {
        const { status } = store.state();
        return container !== null && (status === 'loading' || status === 'live');
      };

      const disconnect = () => {
        source?.close();
        source = null;
      };

      const clearQuietTimer = () => {
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = null;
      };

      const showArrived = () => {
        if (frame !== null) document.defaultView?.cancelAnimationFrame(frame);
        frame = null;
        if (arrived.length === 0) return;
        patchState(store, {
          entries: [...store.entries(), ...arrived].slice(-LOG_LIMITS.maxLinesInView),
          state: { status: 'live' },
        });
        arrived = [];
      };

      const finish = (state: LogStreamState) => {
        disconnect();
        clearQuietTimer();
        showArrived();
        patchState(store, { state });
      };

      const connect = () => {
        const query = new URLSearchParams({ tail: String(tail) });
        if (lastId) query.set('since', lastId);
        const opened = eventSourceFactory(`${containerLogsPath(container!)}?${query}`);
        source = opened;
        if (store.state().status === 'loading') {
          // Docker sends nothing for a container without output.
          clearQuietTimer();
          quietTimer = setTimeout(() => {
            quietTimer = null;
            if (store.state().status === 'loading')
              patchState(store, { state: { status: 'live' } });
          }, QUIET_MS);
        }
        opened.addEventListener(LOGS_EVENTS.lines, (event: MessageEvent) => {
          if (opened !== source) return;
          const parsed = logsLinesSchema.safeParse(JSON.parse(event.data));
          if (!parsed.success) return;
          lastId = event.lastEventId || lastId;
          clearQuietTimer();
          for (const line of parsed.data.lines) arrived.push({ id: nextId++, ...line });
          // A flood while frames are slow: only what can be shown is kept.
          const excess = arrived.length - LOG_LIMITS.maxLinesInView;
          if (excess > 0) arrived.splice(0, excess);
          frame ??= document.defaultView?.requestAnimationFrame(showArrived) ?? null;
        });
        opened.addEventListener(LOGS_EVENTS.end, (event: MessageEvent) => {
          if (opened !== source) return;
          const parsed = logsEndSchema.safeParse(JSON.parse(event.data));
          const reason = parsed.success ? parsed.data.reason : 'error';
          finish({ status: 'ended', reason });
        });
        // While reconnecting, `EventSource` tries again by itself; closed, it has given up
        // (an error answer: the session ended, or the server refused the request).
        opened.onerror = () => {
          if (opened === source && opened.readyState === EVENT_SOURCE_CLOSED) {
            finish({ status: 'ended', reason: 'error' });
          }
        };
      };

      /** Stops the stream and forgets its lines. Idempotent. */
      const close = () => {
        disconnect();
        clearQuietTimer();
        if (frame !== null) document.defaultView?.cancelAnimationFrame(frame);
        frame = null;
        arrived = [];
        container = null;
        lastId = null;
        patchState(store, initialState);
      };

      const onVisibilityChange = () => {
        if (!active()) return;
        if (document.visibilityState === 'hidden') {
          disconnect();
          clearQuietTimer();
        } else if (!source) {
          connect();
        }
      };
      document.addEventListener('visibilitychange', onVisibilityChange);
      inject(DestroyRef).onDestroy(() =>
        document.removeEventListener('visibilitychange', onVisibilityChange),
      );

      return {
        /** Starts (or restarts) the stream of `name`, from its last `tailLines` lines. */
        open(name: string, tailLines: number = LOG_LIMITS.defaultTail): void {
          close();
          container = name;
          tail = tailLines;
          patchState(store, { state: { status: 'loading' } });
          if (document.visibilityState !== 'hidden') connect();
        },
        close,
      };
    },
  ),
  withHooks((store, authStore = inject(AuthStore)) => ({
    onInit() {
      effect(() => {
        // Untracked: close() reads and sets the state, which must not re-run this effect.
        if (!authStore.isAuthenticated()) untracked(() => store.close());
      });
    },
    onDestroy() {
      store.close();
    },
  })),
);
