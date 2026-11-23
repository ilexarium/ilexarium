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
import type { AppStarted, AppSummary, Container } from '@ilex/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { catchError, EMPTY, exhaustMap, firstValueFrom, mergeMap, pipe, tap } from 'rxjs';
import { AppsStore } from '../../../core/apps/apps-store';
import { AppActionsService } from '../../../core/apps/services/app-actions-service';
import { ContainerActionsStore } from '../../../core/containers/container-actions-store';
import { LinuxSessionStore } from '../../../core/linux/linux-session-store';
import { MonitoringStore } from '../../../core/monitoring/monitoring-store';
import { Translator } from '../../../core/i18n/translator';
import { apiErrorText } from '../../../shared/forms/submission-errors';
import { BackupsStore } from '../../../core/backups/backups-store';
import { needsAttention } from '../../containers/container-groups';
import { appStats } from '../app-stats';
import { headline } from '../../../shared/headline/headline';
import type { Headline } from '../../../shared/headline/headline.model';
import type { AppStats } from '../apps.model';

interface AppsPageState {
  /** With a Linux session: the apps in `~/apps` that don't run (no containers). */
  withoutContainers: AppSummary[];
  /** Apps whose start request is in flight, by name. */
  requesting: string[];
  /** Apps whose start task this page follows, by name. */
  following: string[];
}

/**
 * The Apps page: every app Docker knows, live from the `containers` topic, and — signed in to
 * Linux — those in the person's `~/apps` without containers. Start and stop act on each container.
 */
export const AppsPageStore = signalStore(
  withState<AppsPageState>({ withoutContainers: [], requesting: [], following: [] }),
  withComputed(
    (
      store,
      appsStore = inject(AppsStore),
      containerActionsStore = inject(ContainerActionsStore),
      monitoringStore = inject(MonitoringStore),
      backupsStore = inject(BackupsStore),
    ) => {
      const apps = computed(() => {
        const live = appsStore.apps();
        if (live === null) return null;
        const names = new Set(live.map((app) => app.name));
        return [...live, ...store.withoutContainers().filter((app) => !names.has(app.name))].sort(
          (a, b) => a.name.localeCompare(b.name),
        );
      });
      /** Each app's containers, by its name. */
      const containers = computed(() => {
        const byApp = new Map<string, Container[]>();
        const snapshot = monitoringStore.containers();
        for (const container of snapshot?.dockerAvailable ? snapshot.containers : []) {
          const project = container.composeProject;
          if (!project || container.protected) continue;
          const own = byApp.get(project);
          if (own) own.push(container);
          else byApp.set(project, [container]);
        }
        return byApp;
      });
      return {
        apps,
        /** Apps without containers being started (`up`), by name. */
        starting: computed(() => [...store.requesting(), ...store.following()]),
        dockerAvailable: appsStore.dockerAvailable,
        templates: appsStore.templatesById,
        pending: computed(() => new Set(containerActionsStore.pending().keys())),
        stats: computed(() => {
          const snapshot = monitoringStore.containers();
          const history = snapshot?.dockerAvailable ? snapshot.history : {};
          const stats = new Map<string, AppStats>();
          for (const [name, own] of containers()) {
            const summed = appStats(own, history);
            if (summed) stats.set(name, summed);
          }
          return stats;
        }),
        backups: backupsStore.apps,
        /** None before the first snapshot or without apps: the list says so. */
        headline: computed<Headline | null>(() => {
          const list = apps();
          if (!list || list.length === 0) return null;
          return headline(
            'apps.headline',
            list.length,
            list.filter(
              (app) =>
                app.state === 'unhealthy' ||
                (containers().get(app.name) ?? []).some(needsAttention),
            ).length,
            list.filter((app) => app.state === 'running').length,
          );
        }),
      };
    },
  ),
  withMethods(
    (
      store,
      appActionsService = inject(AppActionsService),
      containerActionsStore = inject(ContainerActionsStore),
      translator = inject(Translator),
    ) => {
      const loadWithoutContainers = rxMethod<void>(
        pipe(
          exhaustMap(() =>
            appActionsService.list().pipe(
              tap(({ apps }) =>
                patchState(store, { withoutContainers: apps.filter((a) => a.state === 'none') }),
              ),
              catchError(() => EMPTY),
            ),
          ),
        ),
      );

      /**
       * Card starts while the page is open, side by side: how each ended said in a toast (a card
       * has no task output to show), then the apps without containers read again.
       */
      const followStart = rxMethod<AppStarted>(
        pipe(
          mergeMap(({ name, folder }) =>
            appActionsService.followTask(name, folder).pipe(
              tap({
                next: (task) => {
                  if (task.state === 'succeeded')
                    toast.success(translator.t('apps.starting.done', { name }));
                  else if (task.state !== 'running')
                    toast.error(translator.t('apps.starting.failed', { name }));
                },
                // Ended or given up (never when the page is left).
                complete: () => {
                  patchState(store, { following: store.following().filter((n) => n !== name) });
                  loadWithoutContainers();
                },
              }),
            ),
          ),
        ),
      );

      /** An app without containers: `up` as the person. */
      const startWithoutContainers = async (name: string, folder: string): Promise<void> => {
        patchState(store, { requesting: [...store.requesting(), name] });
        try {
          const started = await firstValueFrom(appActionsService.start(name, folder));
          // Not started (the sign-in dismissed): the list as it is now.
          if (!started) {
            loadWithoutContainers();
            return;
          }
          toast.info(translator.t('apps.starting.started', { name }));
          patchState(store, { following: [...store.following(), name] });
          followStart(started);
        } catch (error) {
          toast.error(translator.t('apps.starting.failed', { name }), {
            description: translator.t(...apiErrorText(error)),
          });
          loadWithoutContainers();
        } finally {
          patchState(store, { requesting: store.requesting().filter((n) => n !== name) });
        }
      };

      return {
        loadWithoutContainers,
        async act(app: AppSummary, action: 'start' | 'stop'): Promise<void> {
          if (action === 'start' && app.state === 'none' && app.folder) {
            await startWithoutContainers(app.name, app.folder);
            return;
          }
          await containerActionsStore.runAll(app.containers, action, app.name);
        },
      };
    },
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
          store.loadWithoutContainers();
        },
        onDestroy() {
          stop?.();
        },
      };
    },
  ),
);
