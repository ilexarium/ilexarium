import { computed, inject } from '@angular/core';
import {
  patchState,
  signalStore,
  withComputed,
  withHooks,
  withMethods,
  withState,
} from '@ngrx/signals';
import { type CatalogEntrySummary, type InstalledService, serviceProject } from '@laris/shared';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import { toast } from '@spartan-ng/brain/sonner';
import { catchError, EMPTY, exhaustMap, mergeMap, pipe, tap } from 'rxjs';
import { Translator } from '../../../core/i18n/translator';
import { BackupsStore } from '../../../core/backups/backups-store';
import { MonitoringStore } from '../../../core/monitoring/monitoring-store';
import { ServicesApi } from '../../../core/services/services-api';
import { ServicesStore } from '../../../core/services/services-store';
import { apiErrorText } from '../../../shared/forms/submission-errors';
import type { ServiceBackup, ServiceRuntime } from '../services.model';

interface ServicesPageState {
  /** Null until loaded. */
  catalog: CatalogEntrySummary[] | null;
  catalogFailed: boolean;
}

export const ServicesPageStore = signalStore(
  withState<ServicesPageState>({ catalog: null, catalogFailed: false }),
  withComputed(
    (
      store,
      servicesStore = inject(ServicesStore),
      monitoringStore = inject(MonitoringStore),
      backupsStore = inject(BackupsStore),
    ) => ({
      /** The installed services, live; null until the first snapshot. */
      installed: computed(() => servicesStore.services()),

      /** Each catalog entry's state: an installed one's own, else removed or never installed. */
      statuses: computed(() => {
        const installed = servicesStore.services();
        const statuses = new Map((store.catalog() ?? []).map((entry) => [entry.id, entry.status]));
        if (!installed) return statuses;
        // Not in the installed list (any more): never installed, or removed — its settings stay.
        for (const [id, status] of statuses) if (status !== null) statuses.set(id, 'removed');
        for (const service of installed) statuses.set(service.catalogId, service.status);
        return statuses;
      }),

      /** What each installed service's containers (Compose project `hl-<id>`) are doing. */
      runtimes: computed(() => {
        const snapshot = monitoringStore.containers();
        const runtimes = new Map<string, ServiceRuntime>();
        if (!snapshot?.dockerAvailable) return runtimes;
        for (const service of servicesStore.services() ?? []) {
          const project = serviceProject(service.catalogId);
          const containers = snapshot.containers.filter((c) => c.composeProject === project);
          const running = containers.filter((c) => c.state === 'running');
          runtimes.set(
            service.catalogId,
            containers.some((c) => c.health === 'unhealthy')
              ? 'unhealthy'
              : running.length === 0
                ? 'stopped'
                : running.length < containers.length
                  ? 'partial'
                  : 'running',
          );
        }
        return runtimes;
      }),

      /** Each installed service's backups, by service id — only once backups are set up. */
      backups: computed(() => {
        const result = new Map<string, ServiceBackup>();
        if (!backupsStore.configured()) return result;
        const items = backupsStore.services();
        for (const service of servicesStore.services() ?? []) {
          const item = items.get(service.id);
          result.set(
            service.id,
            !item
              ? { state: 'none' }
              : item.lastStatus === 'failed'
                ? { state: 'failed', at: item.lastSuccessAt }
                : item.lastSuccessAt
                  ? { state: 'ok', at: item.lastSuccessAt }
                  : { state: 'never' },
          );
        }
        return result;
      }),
    }),
  ),
  withMethods((store, servicesApi = inject(ServicesApi), translator = inject(Translator)) => ({
    loadCatalog: rxMethod<void>(
      pipe(
        exhaustMap(() =>
          servicesApi.catalog().pipe(
            tap((catalog) => patchState(store, { catalog, catalogFailed: false })),
            catchError(() => {
              patchState(store, { catalogFailed: true });
              return EMPTY;
            }),
          ),
        ),
      ),
    ),

    /** Starts the removal (already confirmed); its progress arrives through the topic. */
    remove: rxMethod<InstalledService>(
      pipe(
        mergeMap((service) =>
          servicesApi.remove(service.id).pipe(
            catchError((error: unknown) => {
              toast.error(translator.t('services.remove.failed', { name: service.name }), {
                description: translator.t(...apiErrorText(error)),
              });
              return EMPTY;
            }),
          ),
        ),
      ),
    ),
  })),
  withHooks(
    (store, servicesStore = inject(ServicesStore), monitoringStore = inject(MonitoringStore)) => {
      const stops: (() => void)[] = [];
      return {
        onInit() {
          stops.push(servicesStore.watch(), monitoringStore.watch(['containers']));
          store.loadCatalog();
        },
        onDestroy() {
          for (const stop of stops) stop();
        },
      };
    },
  ),
);
