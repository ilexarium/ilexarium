import { computed, inject } from '@angular/core';
import {
  patchState,
  signalStore,
  withComputed,
  withHooks,
  withMethods,
  withState,
} from '@ngrx/signals';
import { type CatalogEntrySummary, type InstalledService, serviceProject } from '@homelab/shared';
import { toast } from '@spartan-ng/brain/sonner';
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

/**
 * The Services page's data, provided by the page and gone with it (not global): the catalog,
 * each entry's state, each installed service's runtime state, and Remove. Follows the
 * `services` topic (our installs and jobs) and the `containers` topic (what Docker is doing)
 * while the page is open.
 */
export const ServicesPageStore = signalStore(
  withState<ServicesPageState>({ catalog: null, catalogFailed: false }),
  withComputed(
    (
      store,
      services = inject(ServicesStore),
      monitoring = inject(MonitoringStore),
      backups = inject(BackupsStore),
    ) => ({
      /** The installed services, live; null until the first snapshot. */
      installed: computed(() => services.services()),

      /** Each catalog entry's state: an installed one's own, else removed or never installed. */
      statuses: computed(() => {
        const installed = services.services();
        const statuses = new Map((store.catalog() ?? []).map((entry) => [entry.id, entry.status]));
        if (!installed) return statuses;
        // Not in the installed list (any more): never installed, or removed — its settings stay.
        for (const [id, status] of statuses) if (status !== null) statuses.set(id, 'removed');
        for (const service of installed) statuses.set(service.catalogId, service.status);
        return statuses;
      }),

      /** What each installed service's containers (Compose project `hl-<id>`) are doing. */
      runtimes: computed(() => {
        const snapshot = monitoring.containers();
        const runtimes = new Map<string, ServiceRuntime>();
        if (!snapshot?.dockerAvailable) return runtimes;
        for (const service of services.services() ?? []) {
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
        if (!backups.configured()) return result;
        const items = backups.services();
        for (const service of services.services() ?? []) {
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
  withMethods((store, api = inject(ServicesApi), translator = inject(Translator)) => ({
    async loadCatalog(): Promise<void> {
      try {
        patchState(store, { catalog: await api.catalog(), catalogFailed: false });
      } catch {
        patchState(store, { catalogFailed: true });
      }
    },

    /** Starts the removal (already confirmed); its progress arrives through the topic. */
    async remove(service: InstalledService): Promise<void> {
      try {
        await api.remove(service.id);
      } catch (error) {
        toast.error(translator.t('services.remove.failed', { name: service.name }), {
          description: translator.t(...apiErrorText(error)),
        });
      }
    },
  })),
  withHooks((store, services = inject(ServicesStore), monitoring = inject(MonitoringStore)) => {
    const stops: (() => void)[] = [];
    return {
      onInit() {
        stops.push(services.watch(), monitoring.watch(['containers']));
        void store.loadCatalog();
      },
      onDestroy() {
        for (const stop of stops) stop();
      },
    };
  }),
);
