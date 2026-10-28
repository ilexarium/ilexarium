import { computed, effect, inject } from '@angular/core';
import {
  patchState,
  signalStore,
  withComputed,
  withHooks,
  withMethods,
  withState,
} from '@ngrx/signals';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import { type AppSummary, appsFromContainers, type TemplateSummary } from '@laris/shared';
import { catchError, EMPTY, exhaustMap, pipe, tap } from 'rxjs';
import { AuthStore } from '../auth/auth-store';
import { MonitoringStore } from '../monitoring/monitoring-store';
import { AppsApi } from './apps-api';

interface AppsState {
  /** Null until loaded (once a session). */
  templates: TemplateSummary[] | null;
}

const initialState: AppsState = { templates: null };

/**
 * The apps Docker knows, live from the `containers` topic (whoever follows it — the dashboard,
 * the Apps page), with what the templates add (the "Open" port). Global, so the list is there at
 * once when coming back to a page; reset on sign-out.
 */
export const AppsStore = signalStore(
  { providedIn: 'root' },
  withState<AppsState>(initialState),
  withComputed((store, monitoringStore = inject(MonitoringStore)) => ({
    /** Null until the containers' first snapshot. */
    apps: computed<AppSummary[] | null>(() => {
      const snapshot = monitoringStore.containers();
      if (!snapshot) return null;
      if (!snapshot.dockerAvailable) return [];
      const ports = new Map((store.templates() ?? []).map((t) => [t.id, t.webPort]));
      return appsFromContainers(snapshot.containers, (id) => ports.get(id) ?? null);
    }),
    dockerAvailable: computed(() => monitoringStore.containers()?.dockerAvailable ?? true),
    templatesById: computed(() => new Map((store.templates() ?? []).map((t) => [t.id, t]))),
  })),
  withMethods((store, appsApi = inject(AppsApi)) => ({
    loadTemplates: rxMethod<void>(
      pipe(
        exhaustMap(() =>
          appsApi.templates().pipe(
            tap((templates) => patchState(store, { templates })),
            catchError(() => EMPTY),
          ),
        ),
      ),
    ),
  })),
  withHooks((store, authStore = inject(AuthStore)) => ({
    onInit() {
      effect(() => {
        if (!authStore.isAuthenticated()) patchState(store, initialState);
        else if (store.templates() === null) store.loadTemplates();
      });
    },
  })),
);
