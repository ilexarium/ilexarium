import { effect, inject } from '@angular/core';
import { patchState, signalStore, withHooks, withMethods, withState } from '@ngrx/signals';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
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
import { catchError, EMPTY, exhaustMap, filter, pipe, tap } from 'rxjs';
import { AuthStore } from '../auth/auth-store';
import { RealtimeService } from '../realtime/realtime-service';
import { MonitoringApi } from './monitoring-api';

interface MonitoringState {
  /** Null until the first snapshot. */
  system: SystemSnapshot | null;
  containers: ContainersSnapshot | null;
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
    (
      store,
      realtimeService = inject(RealtimeService),
      monitoringApi = inject(MonitoringApi),
      authStore = inject(AuthStore),
    ) => ({
      /** Once per sign-in (the top bar's kernel); a failure leaves it out until the next one. */
      loadHost: rxMethod<void>(
        pipe(
          filter(() => !store.host()),
          exhaustMap(() =>
            monitoringApi.host().pipe(
              // Signed out while it was asked for: nothing of it stays.
              tap((host) => {
                if (authStore.isAuthenticated()) patchState(store, { host });
              }),
              catchError(() => EMPTY),
            ),
          ),
        ),
      ),

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
              patchState(store, { system: message.data });
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
                patchState(store, {
                  containers: applyContainersUpdate(containers, message.data),
                });
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
