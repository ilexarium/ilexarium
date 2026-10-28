import { computed, inject } from '@angular/core';
import {
  patchState,
  signalStore,
  withComputed,
  withHooks,
  withMethods,
  withState,
} from '@ngrx/signals';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import type { AppSummary } from '@laris/shared';
import { catchError, EMPTY, exhaustMap, pipe, tap } from 'rxjs';
import { AppsApi } from '../../../core/apps/apps-api';
import { AppsStore } from '../../../core/apps/apps-store';
import { ContainerActionsStore } from '../../../core/containers/container-actions-store';
import { LinuxSessionStore } from '../../../core/linux/linux-session-store';
import { MonitoringStore } from '../../../core/monitoring/monitoring-store';

interface AppsPageState {
  /** With a Linux session: the apps in `~/apps` that don't run (no containers). */
  resting: AppSummary[];
}

/**
 * The Apps page: every app Docker knows, live from the `containers` topic, and — signed in to
 * Linux — those in the person's `~/apps` without containers. Start and stop act on each container.
 */
export const AppsPageStore = signalStore(
  withState<AppsPageState>({ resting: [] }),
  withComputed(
    (
      store,
      appsStore = inject(AppsStore),
      containerActionsStore = inject(ContainerActionsStore),
    ) => ({
      apps: computed(() => {
        const live = appsStore.apps();
        if (live === null) return null;
        const names = new Set(live.map((app) => app.name));
        return [...live, ...store.resting().filter((app) => !names.has(app.name))].sort((a, b) =>
          a.name.localeCompare(b.name),
        );
      }),
      dockerAvailable: appsStore.dockerAvailable,
      templates: appsStore.templatesById,
      pending: computed(() => new Set(containerActionsStore.pending().keys())),
    }),
  ),
  withMethods(
    (store, appsApi = inject(AppsApi), containerActionsStore = inject(ContainerActionsStore)) => ({
      loadResting: rxMethod<void>(
        pipe(
          exhaustMap(() =>
            appsApi.list().pipe(
              tap(({ apps }) =>
                patchState(store, { resting: apps.filter((a) => a.state === 'none') }),
              ),
              catchError(() => EMPTY),
            ),
          ),
        ),
      ),
      async act(app: AppSummary, action: 'start' | 'stop'): Promise<void> {
        await containerActionsStore.runAll(app.containers, action, app.name);
      },
    }),
  ),
  withHooks(
    (
      store,
      monitoringStore = inject(MonitoringStore),
      linuxSessionStore = inject(LinuxSessionStore),
    ) => {
      let stop: (() => void) | undefined;
      return {
        onInit() {
          stop = monitoringStore.watch(['containers']);
          linuxSessionStore.check();
          store.loadResting();
        },
        onDestroy() {
          stop?.();
        },
      };
    },
  ),
);
