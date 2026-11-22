import { computed, inject } from '@angular/core';
import {
  patchState,
  signalStoreFeature,
  withComputed,
  withHooks,
  withMethods,
  withState,
} from '@ngrx/signals';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import { toast } from '@spartan-ng/brain/sonner';
import { catchError, EMPTY, pipe, switchMap, tap } from 'rxjs';
import { AppsStore } from '../../../../core/apps/apps-store';
import { AppActionsService } from '../../../../core/apps/services/app-actions-service';
import { ContainerActionsStore } from '../../../../core/containers/container-actions-store';
import { Translator } from '../../../../core/i18n/translator';
import { MonitoringStore } from '../../../../core/monitoring/monitoring-store';
import { apiErrorCode, apiErrorText } from '../../../../shared/forms/submission-errors';
import { appStats } from '../../app-stats';
import type { AppTab, ContainerWithStats } from '../../apps.model';
import type { AppDetailsState } from './app-page-store.model';
import { initialAppDetailsState } from './app-page-store.constants';

/**
 * The app as read: its files as the signed-in Linux account (fresh each time), its containers
 * live from Docker, and the page's request in flight — what every other part of the page uses.
 */
export function withAppDetails() {
  return signalStoreFeature(
    withState<AppDetailsState>({ ...initialAppDetailsState, tab: 'overview' }),
    withComputed(
      (
        store,
        appsStore = inject(AppsStore),
        containerActionsStore = inject(ContainerActionsStore),
        monitoringStore = inject(MonitoringStore),
      ) => {
        /** Live from the containers topic, else as read with the files. */
        const summary = computed(
          () =>
            appsStore.apps()?.find((app) => app.name === store.name()) ??
            store.details()?.app ??
            null,
        );
        /** Its containers, live (from Docker: no Linux sign-in needed). */
        const containers = computed(() => {
          const snapshot = monitoringStore.containers();
          return (snapshot?.dockerAvailable ? snapshot.containers : [])
            .filter((c) => c.composeProject === store.name() && !c.protected)
            .sort((a, b) => a.name.localeCompare(b.name));
        });
        const history = computed(() => {
          const snapshot = monitoringStore.containers();
          return snapshot?.dockerAvailable ? snapshot.history : {};
        });
        return {
          summary,
          containers,
          history,
          stats: computed(() => appStats(containers(), history())),
          containerStats: computed<ContainerWithStats[]>(() =>
            containers().map((container) => ({
              container,
              stats: appStats([container], history()),
            })),
          ),
          /** Its template as the catalog has it; null without one, or one no longer there. */
          template: computed(() => {
            const id = summary()?.template?.id;
            return id ? (appsStore.templatesById().get(id) ?? null) : null;
          }),
          busy: store.requesting,
          /** Its files read and no container of it in Docker, running or stopped: they may go. */
          filesOnly: computed(
            () => !!store.details() && summary()?.state === 'none' && containers().length === 0,
          ),
          pending: computed(() => {
            const pending = containerActionsStore.pending();
            return (summary()?.containers ?? []).some((name) => pending.has(name));
          }),
          // A link's folder only for an app neither Docker nor the list knows (one just
          // installed elsewhere): never in place of the folder Docker runs it from.
          folder: computed(
            () => store.details()?.folder ?? summary()?.folder ?? store.folderHint() ?? '',
          ),
        };
      },
    ),
    withMethods(
      (store, appActionsService = inject(AppActionsService), translator = inject(Translator)) => ({
        load: rxMethod<void>(
          pipe(
            switchMap(() =>
              appActionsService.details(store.name(), store.folderHint() ?? undefined).pipe(
                tap((details) =>
                  patchState(store, {
                    details,
                    // Kept: once Docker no longer knows the app (removed), its folder is still found.
                    folderHint: details.folder,
                    loadError: null,
                  }),
                ),
                catchError((error: unknown) => {
                  patchState(store, { loadError: apiErrorCode(error) ?? 'failed' });
                  return EMPTY;
                }),
              ),
            ),
          ),
        ),

        setTab(tab: AppTab): void {
          patchState(store, { tab });
        },

        /**
         * One of the page's requests: `requesting` meanwhile, a refusal worded under `errorKey`
         * (unless `handleRefusal` took it). Null when refused or the prompt was dismissed.
         */
        async _request<T>(
          errorKey: string,
          action: () => Promise<T | null>,
          handleRefusal?: (error: unknown) => boolean,
        ): Promise<T | null> {
          patchState(store, { requesting: true });
          try {
            return await action();
          } catch (error) {
            if (!handleRefusal?.(error))
              toast.error(translator.t(errorKey, { name: store.name() }), {
                description: translator.t(...apiErrorText(error)),
              });
            return null;
          } finally {
            patchState(store, { requesting: false });
          }
        },
      }),
    ),
    withMethods((store, appActionsService = inject(AppActionsService)) => ({
      reload(): void {
        store.load();
      },

      /** Signed in to Linux first, then read (the files are the person's). */
      async signInAndLoad(): Promise<void> {
        if (await appActionsService.signIn()) store.load();
      },
    })),
    withHooks((_store, monitoringStore = inject(MonitoringStore)) => {
      let stop: (() => void) | undefined;
      return {
        onInit() {
          stop = monitoringStore.watch(['containers']);
        },
        onDestroy() {
          stop?.();
        },
      };
    }),
  );
}
