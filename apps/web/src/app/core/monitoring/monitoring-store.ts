import { effect, inject } from '@angular/core';
import { patchState, signalStore, withHooks, withMethods, withState } from '@ngrx/signals';
import {
  type ContainerHistoryPoint,
  type RealtimeTopic,
  type ContainersSnapshot,
  type ContainersUpdate,
  HISTORY_WINDOW_MS,
  type HostInfo,
  type SystemSnapshot,
  type SystemUpdate,
  toContainerHistoryPoint,
  toSystemHistoryPoint,
} from '@laris/shared';
import { AuthStore } from '../auth/auth-store';
import { RealtimeService } from '../realtime/realtime-service';
import { MonitoringApi } from './monitoring-api';

interface MonitoringState {
  /** Null until the first snapshot. */
  system: SystemSnapshot | null;
  containers: ContainersSnapshot | null;
  /** The machine (the top bar shows its kernel): loaded once, or from a system snapshot. */
  host: HostInfo | null;
}

const initialState: MonitoringState = { system: null, containers: null, host: null };

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

/** Global, so returning to the dashboard shows the last values at once (a fresh snapshot follows). */
export const MonitoringStore = signalStore(
  { providedIn: 'root' },
  withState<MonitoringState>(initialState),
  withMethods(
    (store, realtimeService = inject(RealtimeService), monitoringApi = inject(MonitoringApi)) => ({
      /** The machine's info, once per sign-in; without it the top bar shows no kernel. */
      async loadHost(): Promise<void> {
        if (store.host()) return;
        try {
          patchState(store, { host: await monitoringApi.host() });
        } catch {
          // Not essential: the next sign-in (or the dashboard's snapshot) brings it.
        }
      },

      watch(topics: readonly RealtimeTopic[]): () => void {
        const stops: (() => void)[] = [];
        if (topics.includes('system')) stops.push(watchSystem());
        if (topics.includes('containers')) stops.push(watchContainers());
        return () => {
          for (const stop of stops) stop();
        };

        function watchSystem(): () => void {
          return realtimeService.subscribe('system', (message) => {
            if (message.event === 'system:snapshot') {
              patchState(store, { system: message.data, host: message.data.host });
            } else if (message.event === 'system:update') {
              const system = store.system();
              if (system) patchState(store, { system: applySystemUpdate(system, message.data) });
            }
          });
        }

        function watchContainers(): () => void {
          return realtimeService.subscribe('containers', (message) => {
            if (message.event === 'containers:snapshot') {
              patchState(store, { containers: message.data });
            } else if (message.event === 'containers:update') {
              const containers = store.containers();
              if (containers) {
                patchState(store, { containers: applyContainersUpdate(containers, message.data) });
              }
            }
          });
        }
      },
    }),
  ),
  withHooks((store, authStore = inject(AuthStore)) => ({
    onInit() {
      effect(() => {
        if (!authStore.isAuthenticated()) patchState(store, initialState);
      });
    },
  })),
);
