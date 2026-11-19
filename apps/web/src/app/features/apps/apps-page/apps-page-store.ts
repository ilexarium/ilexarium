import { computed, effect, inject, untracked } from '@angular/core';
import {
  patchState,
  signalStore,
  withComputed,
  withHooks,
  withMethods,
  withState,
} from '@ngrx/signals';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import type { AppSummary, Container } from '@ilex/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { catchError, EMPTY, exhaustMap, pipe, tap } from 'rxjs';
import { AppTasksStore, taskEnded } from '../../../core/apps/app-tasks-store';
import type { AppTasksVisit } from '../../../core/apps/apps.model';
import { AppsApi } from '../../../core/apps/apps-api';
import { AppsStore } from '../../../core/apps/apps-store';
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
  resting: AppSummary[];
  /** Apps whose start request is in flight, by name (their tasks are AppTasksStore's). */
  requesting: string[];
  /** Where this visit started: the page reacts only to tasks that end during it. */
  visit: AppTasksVisit | null;
}

/**
 * The Apps page: every app Docker knows, live from the `containers` topic, and — signed in to
 * Linux — those in the person's `~/apps` without containers. Start and stop act on each container.
 */
export const AppsPageStore = signalStore(
  withState<AppsPageState>({ resting: [], requesting: [], visit: null }),
  withComputed(
    (
      store,
      appTasksStore = inject(AppTasksStore),
      appsStore = inject(AppsStore),
      containerActionsStore = inject(ContainerActionsStore),
      monitoringStore = inject(MonitoringStore),
      backupsStore = inject(BackupsStore),
    ) => {
      const apps = computed(() => {
        const live = appsStore.apps();
        if (live === null) return null;
        const names = new Set(live.map((app) => app.name));
        return [...live, ...store.resting().filter((app) => !names.has(app.name))].sort((a, b) =>
          a.name.localeCompare(b.name),
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
        starting: computed(() => [
          ...store.requesting(),
          ...Object.entries(appTasksStore.tasks())
            .filter(([, entry]) => entry.kind === 'start' && !taskEnded(entry))
            .map(([name]) => name),
        ]),
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
      appsApi = inject(AppsApi),
      appTasksStore = inject(AppTasksStore),
      containerActionsStore = inject(ContainerActionsStore),
      translator = inject(Translator),
    ) => {
      const loadResting = rxMethod<void>(
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
      );

      /** An app without containers: `up` as the person, through AppTasksStore (it says how it ends). */
      const startResting = async (name: string, folder: string): Promise<void> => {
        patchState(store, { requesting: [...store.requesting(), name] });
        try {
          // Not started (the sign-in dismissed): the list as it is now.
          if (!(await appTasksStore.start(name, folder, true))) loadResting();
        } catch (error) {
          toast.error(translator.t('apps.starting.failed', { name }), {
            description: translator.t(...apiErrorText(error)),
          });
          loadResting();
        } finally {
          patchState(store, { requesting: store.requesting().filter((n) => n !== name) });
        }
      };

      return {
        loadResting,
        async act(app: AppSummary, action: 'start' | 'stop'): Promise<void> {
          if (action === 'start' && app.state === 'none' && app.folder) {
            await startResting(app.name, app.folder);
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
      appTasksStore = inject(AppTasksStore),
      monitoringStore = inject(MonitoringStore),
      linuxSessionStore = inject(LinuxSessionStore),
    ) => {
      let stop: (() => void) | undefined;
      return {
        onInit() {
          stop = monitoringStore.watch(['containers']);
          linuxSessionStore.check();
          patchState(store, { visit: appTasksStore.visit() });
          store.loadResting();
          // A start of this visit ending: the apps without containers read again (once each).
          const handled = new Set<number>();
          effect(() => {
            for (const entry of Object.values(appTasksStore.tasks())) {
              if (entry.kind !== 'start' || handled.has(entry.id)) continue;
              if (!appTasksStore.endedDuring(store.visit(), entry)) continue;
              handled.add(entry.id);
              untracked(() => store.loadResting());
            }
          });
        },
        onDestroy() {
          stop?.();
        },
      };
    },
  ),
);
