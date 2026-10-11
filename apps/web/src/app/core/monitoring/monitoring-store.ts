import { effect, inject } from '@angular/core';
import { patchState, signalStore, withHooks, withMethods, withState } from '@ngrx/signals';
import {
  type ContainerHistoryPoint,
  type ContainersSnapshot,
  type ContainersUpdate,
  type SystemSnapshot,
  type SystemUpdate,
  toContainerHistoryPoint,
  toSystemHistoryPoint,
} from '@homelab/shared';
import { AuthStore } from '../auth/auth-store';
import { RealtimeService } from '../realtime/realtime-service';

/** How much chart history is kept — the same window the server sends. */
export const HISTORY_WINDOW_MS = 15 * 60_000;

interface MonitoringState {
  /** Null until the first snapshot. */
  system: SystemSnapshot | null;
  containers: ContainersSnapshot | null;
}

const initialState: MonitoringState = { system: null, containers: null };

/** An update after a snapshot: the latest values, plus one chart point; old points drop out. */
export function applySystemUpdate(state: SystemSnapshot, update: SystemUpdate): SystemSnapshot {
  const point = toSystemHistoryPoint(update.sample);
  const cutoff = point.at - HISTORY_WINDOW_MS;
  return {
    ...state,
    ...update,
    history: [...state.history.filter((p) => p.at >= cutoff && p.at < point.at), point],
  };
}

/**
 * The latest list, plus a chart point for each container with a new stats frame. History is kept
 * for containers still listed (stopped ones too) and dropped for removed ones. Docker becoming
 * unreachable clears everything; becoming reachable again starts from the update.
 */
export function applyContainersUpdate(
  state: ContainersSnapshot,
  update: ContainersUpdate,
): ContainersSnapshot {
  if (!update.dockerAvailable) return { dockerAvailable: false };
  const previous = state.dockerAvailable ? state.history : {};
  const history: Record<string, ContainerHistoryPoint[]> = {};
  for (const container of update.containers) {
    const points = previous[container.id] ?? [];
    const last = points.at(-1);
    if (container.stats && (!last || container.stats.at > last.at)) {
      const point = toContainerHistoryPoint(container.stats);
      const cutoff = point.at - HISTORY_WINDOW_MS;
      history[container.id] = [...points.filter((p) => p.at >= cutoff), point];
    } else if (points.length > 0) {
      history[container.id] = points;
    }
  }
  return { dockerAvailable: true, containers: update.containers, history };
}

/**
 * Live system and container data for the dashboard, fed by the realtime topics while a page
 * `watch()`es them. Global, so returning to the dashboard shows the last values at once (a fresh
 * snapshot follows); reset on sign-out like every global store.
 */
export const MonitoringStore = signalStore(
  { providedIn: 'root' },
  withState<MonitoringState>(initialState),
  withMethods((store, realtime = inject(RealtimeService)) => ({
    /** Subscribes to the system and containers topics until the returned function is called. */
    watch(): () => void {
      const stopSystem = realtime.subscribe('system', (message) => {
        if (message.event === 'system:snapshot') {
          patchState(store, { system: message.data });
        } else if (message.event === 'system:update') {
          const system = store.system();
          if (system) patchState(store, { system: applySystemUpdate(system, message.data) });
        }
      });
      const stopContainers = realtime.subscribe('containers', (message) => {
        if (message.event === 'containers:snapshot') {
          patchState(store, { containers: message.data });
        } else if (message.event === 'containers:update') {
          const containers = store.containers();
          if (containers) {
            patchState(store, { containers: applyContainersUpdate(containers, message.data) });
          }
        }
      });
      return () => {
        stopSystem();
        stopContainers();
      };
    },
  })),
  withHooks((store, auth = inject(AuthStore)) => ({
    onInit() {
      effect(() => {
        if (!auth.isAuthenticated()) patchState(store, initialState);
      });
    },
  })),
);
