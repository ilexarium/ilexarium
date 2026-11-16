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
import {
  type AppSummary,
  appsFromContainers,
  type BackupItemRequest,
  type TemplateSummary,
} from '@ilex/shared';
import { catchError, EMPTY, exhaustMap, firstValueFrom, pipe, tap } from 'rxjs';
import { AuthStore } from '../auth/auth-store';
import { buildAppBackupItem } from '../backups/app-backup-item';
import type { BackupPreset } from '../backups/backups.model';
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
      const pages = new Map(
        (store.templates() ?? []).map((t) => [
          t.id,
          t.webPort === null ? null : { port: t.webPort, path: t.webPath },
        ]),
      );
      return appsFromContainers(snapshot.containers, (id) => pages.get(id) ?? null);
    }),
    dockerAvailable: computed(() => monitoringStore.containers()?.dockerAvailable ?? true),
    templatesById: computed(() => new Map((store.templates() ?? []).map((t) => [t.id, t]))),
  })),
  withMethods((store, appsApi = inject(AppsApi)) => ({
    /**
     * An app's backup item, with its template's preset when it has one (Ollama runs on, its models
     * skipped): the same wherever "Add to backups" is clicked. Rejects when the template can't be
     * read — never a plain "stop, everything" instead.
     */
    async appBackupItem(
      app: Pick<AppSummary, 'name' | 'folder' | 'template'>,
    ): Promise<BackupItemRequest> {
      let preset: BackupPreset = { mode: 'stop', skip: [] };
      if (app.template && app.folder) {
        const { template } = await firstValueFrom(appsApi.template(app.template.id));
        if (template.backup)
          preset = { mode: template.backup.mode, skip: template.backup.skip ?? [] };
      }
      return buildAppBackupItem(app.name, app.folder, preset);
    },

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
