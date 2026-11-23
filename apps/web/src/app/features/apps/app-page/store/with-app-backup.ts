import { computed, inject } from '@angular/core';
import {
  patchState,
  signalStoreFeature,
  type SignalStoreFeatureType,
  type,
  withComputed,
  withMethods,
  withState,
} from '@ngrx/signals';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import { toast } from '@spartan-ng/brain/sonner';
import { EMPTY, exhaustMap, pipe, tap } from 'rxjs';
import { AppActionsService } from '../../../../core/apps/services/app-actions-service';
import { BackupsStore } from '../../../../core/backups/backups-store';
import { Translator } from '../../../../core/i18n/translator';
import type { withAppDetails } from './with-app-details';
import type { AppBackupState } from './app-page-store.model';
import { initialAppBackupState } from './app-page-store.constants';

/** Its backup: when it last ran, Back up now, adding it to the backups. */
export function withAppBackup() {
  return signalStoreFeature(
    type<SignalStoreFeatureType<typeof withAppDetails>>(),
    withState<AppBackupState>(initialAppBackupState),
    withComputed((store, backupsStore = inject(BackupsStore)) => {
      const backup = computed(() => backupsStore.apps().get(store.name()) ?? null);
      /** Started here and not yet ended (the topic may not show it yet). */
      const startedRunPending = computed(() => {
        const runId = store.startedRun();
        return !!runId && backupsStore.status()?.lastRun?.id !== runId;
      });
      return {
        backup,
        backupsConfigured: backupsStore.configured,
        /** A backup runs (only one at a time): no "Back up now" meanwhile. */
        backupRunning: computed(() => backupsStore.running() !== null || startedRunPending()),
        /** This app's backup runs or waits in the running one (it may stop the app): no update. */
        appBackingUp: computed(() => {
          const item = backup();
          const run = backupsStore.running();
          if (startedRunPending() && (!run || run.runId === store.startedRun())) return true;
          return (
            !!item &&
            !!run &&
            run.items.some((entry) => entry.itemId === item.id && entry.state !== 'done')
          );
        }),
      };
    }),
    withMethods(
      (store, appActionsService = inject(AppActionsService), translator = inject(Translator)) => ({
        /** Starts this app's backup; its progress comes with the `backups` topic. */
        backUpNow: rxMethod<void>(
          pipe(
            exhaustMap(() => {
              const item = store.backup();
              if (!item) return EMPTY;
              return store
                ._request('apps.backup.runFailed', appActionsService.backUpNow(item.id))
                .pipe(
                  tap((run) => {
                    if (!run) return;
                    patchState(store, { startedRun: run.runId });
                    toast.info(translator.t('apps.backup.started', { name: store.name() }));
                  }),
                );
            }),
          ),
        ),

        /** Added with its template's preset (refused when the template can't be read). */
        addToBackups: rxMethod<void>(
          pipe(
            exhaustMap(() =>
              store
                ._request(
                  'apps.backup.failed',
                  appActionsService.addToBackups({
                    name: store.name(),
                    folder: store.folder() || null,
                    template: store.details()?.template ?? store.summary()?.template ?? null,
                  }),
                )
                .pipe(
                  tap((item) => {
                    if (item)
                      toast.success(translator.t('apps.backup.added', { name: store.name() }));
                  }),
                ),
            ),
          ),
        ),
      }),
    ),
  );
}
