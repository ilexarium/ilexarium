import { inject } from '@angular/core';
import {
  patchState,
  signalStoreFeature,
  type SignalStoreFeatureType,
  type,
  withMethods,
  withState,
} from '@ngrx/signals';
import type { AppRemovalItem } from '@ilex/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { AppActionsService } from '../../../../core/apps/services/app-actions-service';
import { Translator } from '../../../../core/i18n/translator';
import type { withAppDetails } from './with-app-details';
import type { AppDeletionState } from './app-page-store.model';
import { initialAppDeletionState } from './app-page-store.constants';

/** Deleting the files of an app without containers: the list to tick, then what was ticked. */
export function withAppDeletion() {
  return signalStoreFeature(
    type<SignalStoreFeatureType<typeof withAppDetails>>(),
    withState<AppDeletionState>(initialAppDeletionState),
    withMethods(
      (store, appActionsService = inject(AppActionsService), translator = inject(Translator)) => ({
        /** What "Delete files" may delete, with sizes. */
        async openDeletion(): Promise<void> {
          patchState(store, { removal: null });
          const removal = await store._request('apps.delete.failed', () =>
            appActionsService.removal(store.name(), store.folder()),
          );
          if (removal) patchState(store, { removal: removal.items });
        },

        /** Deletes what was ticked; with its settings the app is gone (back to the list). */
        async deleteFiles(ticked: AppRemovalItem[]): Promise<void> {
          if (ticked.length === 0) return;
          const settings = ticked.some((i) => i.kind === 'settings');
          const done = await store._request('apps.delete.failed', () =>
            appActionsService.deleteFiles(store.name(), {
              folder: store.folder(),
              settings,
              folders: ticked.filter((i) => i.kind === 'folder').map((i) => i.path),
              volumes: ticked.filter((i) => i.kind === 'volume').map((i) => i.path),
            }),
          );
          if (!done) {
            store.load();
            return;
          }
          toast.success(translator.t('apps.delete.done', { name: store.name() }));
          if (settings) patchState(store, { removed: true });
          else store.load();
        },
      }),
    ),
  );
}
