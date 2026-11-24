import { inject } from '@angular/core';
import {
  patchState,
  signalStoreFeature,
  type SignalStoreFeatureType,
  type,
  withMethods,
  withState,
} from '@ngrx/signals';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import { catchError, EMPTY, pipe, switchMap, tap } from 'rxjs';
import { BackupsService } from '../../../../core/backups/services/backups-service';
import type { FolderPickerState } from './backups-page-store.model';
import { initialFolderPickerState } from './backups-page-store.constants';
import type { withBackupsCore } from './with-backups-core';

/** The folder picker for adding a folder. */
export function withFolderPicker() {
  return signalStoreFeature(
    type<SignalStoreFeatureType<typeof withBackupsCore>>(),
    withState<FolderPickerState>(initialFolderPickerState),
    withMethods((store, backupsService = inject(BackupsService)) => ({
      /**
       * The starting places, or inside a folder; the latest click wins. Read as the signed-in
       * Linux account: its sign-in asked for first (closed: nothing changes).
       */
      browse: rxMethod<string | undefined>(
        pipe(
          switchMap((path) =>
            backupsService.folders(path).pipe(
              tap((folders) => {
                if (folders) patchState(store, { folders });
              }),
              catchError((error: unknown) => {
                store._failed('backups.folders.failed', error);
                return EMPTY;
              }),
            ),
          ),
        ),
      ),

      closeBrowser(): void {
        patchState(store, { folders: null });
      },
    })),
  );
}
