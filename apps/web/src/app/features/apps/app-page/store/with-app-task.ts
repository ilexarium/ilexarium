import { computed, inject } from '@angular/core';
import {
  patchState,
  signalStoreFeature,
  type SignalStoreFeatureType,
  type,
  withComputed,
  withHooks,
  withMethods,
  withState,
} from '@ngrx/signals';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import type { AppDetails, AppStarted } from '@ilex/shared';
import { EMPTY, pipe, switchMap, tap } from 'rxjs';
import { AppActionsService } from '../../../../core/apps/services/app-actions-service';
import { ContainerActionsStore } from '../../../../core/containers/container-actions-store';
import type { withAppDetails } from './with-app-details';
import type { AppTaskState } from './app-page-store.model';
import { initialAppTaskState } from './app-page-store.constants';

/**
 * The app's task: the one this page started or found running, followed only to show it (its end
 * reads the files again); Update, Start, Stop and Remove.
 */
export function withAppTask() {
  return signalStoreFeature(
    type<SignalStoreFeatureType<typeof withAppDetails>>(),
    withState<AppTaskState>(initialAppTaskState),
    withComputed((store) => {
      /** The app's latest task: the one followed here, or the one read with its files if newer. */
      const task = computed(() => {
        const followed = store.followed();
        const found = store.details()?.task ?? null;
        const read =
          found?.state === 'running' && found.startedAt === store._givenUp() ? null : found;
        if (!followed || !read) return followed ?? read;
        return followed.startedAt >= read.startedAt ? followed : read;
      });
      return { task, running: computed(() => task()?.state === 'running') };
    }),
    withMethods((store, appActionsService = inject(AppActionsService)) => ({
      /**
       * The app's task, until it ends (a newer one replaces it; null: none), then the files read
       * again. Only to show it: nothing else waits for it.
       */
      follow: rxMethod<Pick<AppStarted, 'folder' | 'task'> | null>(
        pipe(
          switchMap((started) => {
            if (!started) return EMPTY;
            patchState(store, { followed: started.task });
            if (started.task.state !== 'running') return EMPTY;
            return appActionsService.followTask(store.name(), started.folder).pipe(
              tap({
                next: (task) => patchState(store, { followed: task }),
                // Ended or given up (never when the page is left or a newer task replaces it).
                complete: () => {
                  // Given up while it ran: what the files say instead, never this one as running.
                  const followed = store.followed();
                  if (followed?.state === 'running')
                    patchState(store, { followed: null, _givenUp: followed.startedAt });
                  store.load();
                },
              }),
            );
          }),
        ),
      ),
    })),
    withMethods((store) => ({
      /** A task running in what was read (started elsewhere, or before a reload): followed too. */
      _followRunning: rxMethod<AppDetails | null>(
        tap((details) => {
          const found = details?.task;
          if (!details || found?.state !== 'running' || found.startedAt === store._givenUp())
            return;
          const followed = store.followed();
          if (followed?.state === 'running' && followed.startedAt === found.startedAt) return;
          store.follow({ folder: details.folder, task: found });
        }),
      ),

      /** Starts a task through the page's request, then follows it. */
      async _startTask(
        errorKey: string,
        start: () => Promise<AppStarted | null>,
        handleRefusal?: (error: unknown) => boolean,
      ): Promise<void> {
        const name = store.name();
        const started = await store._request(errorKey, start, handleRefusal);
        // Answered after another app was opened here: not this page's.
        if (started && started.name === name && store.name() === name) store.follow(started);
      },
    })),
    withMethods(
      (
        store,
        appActionsService = inject(AppActionsService),
        containerActionsStore = inject(ContainerActionsStore),
      ) => ({
        async update(): Promise<void> {
          await store._startTask('apps.update.failed', () =>
            appActionsService.update(store.name(), store.folder()),
          );
        },

        async act(action: 'start' | 'stop'): Promise<void> {
          const summary = store.summary();
          if (!summary) return;
          if (action === 'start' && summary.state === 'none') {
            await store._startTask('apps.starting.failed', () =>
              appActionsService.start(store.name(), store.folder()),
            );
            return;
          }
          await containerActionsStore.runAll(summary.containers, action, store.name());
        },

        /** `docker compose down`: its containers go, its files stay. */
        async remove(): Promise<void> {
          await store._startTask('apps.remove.failed', () =>
            appActionsService.remove(store.name(), store.folder()),
          );
        },
      }),
    ),
    withHooks((store) => ({
      onInit() {
        store._followRunning(store.details);
      },
    })),
  );
}
