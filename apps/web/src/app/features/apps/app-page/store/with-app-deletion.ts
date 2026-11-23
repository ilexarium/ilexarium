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
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import { toast } from '@spartan-ng/brain/sonner';
import { EMPTY, exhaustMap, pipe, tap } from 'rxjs';
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
        openDeletion: rxMethod<void>(
          pipe(
            exhaustMap(() => {
              patchState(store, { removal: null });
              return store
                ._request(
                  'apps.delete.failed',
                  appActionsService.removal(store.name(), store.folder()),
                )
                .pipe(
                  tap((removal) => {
                    if (removal) patchState(store, { removal: removal.items });
                  }),
                );
            }),
          ),
        ),

        /** Deletes what was ticked; with its settings the app is gone (back to the list). */
        deleteFiles: rxMethod<AppRemovalItem[]>(
          pipe(
            exhaustMap((ticked) => {
              if (ticked.length === 0) return EMPTY;
              const settings = ticked.some((i) => i.kind === 'settings');
              const request = appActionsService.deleteFiles(store.name(), {
                folder: store.folder(),
                settings,
                folders: ticked.filter((i) => i.kind === 'folder').map((i) => i.path),
                volumes: ticked.filter((i) => i.kind === 'volume').map((i) => i.path),
              });
              return store._request('apps.delete.failed', request).pipe(
                tap((done) => {
                  if (!done) {
                    store.load();
                    return;
                  }
                  toast.success(translator.t('apps.delete.done', { name: store.name() }));
                  if (settings) patchState(store, { removed: true });
                  else store.load();
                }),
              );
            }),
          ),
        ),
      }),
    ),
  );
}
