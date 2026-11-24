import { inject } from '@angular/core';
import {
  patchState,
  signalStoreFeature,
  type SignalStoreFeatureType,
  type,
  withMethods,
  withState,
} from '@ngrx/signals';
import type { BackupRestore } from '@ilex/shared';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import { toast } from '@spartan-ng/brain/sonner';
import { catchError, EMPTY, exhaustMap, mergeMap, of, pipe, switchMap, tap } from 'rxjs';
import { BackupsService } from '../../../../core/backups/services/backups-service';
import { Translator } from '../../../../core/i18n/translator';
import { apiErrorCode } from '../../../../shared/forms/submission-errors';
import type { RestoreChoice } from '../../backups.model';
import type { BackupRestoresState } from './backups-page-store.model';
import { initialBackupRestoresState } from './backups-page-store.constants';
import type { withBackupsCore } from './with-backups-core';

/** Restores: an item's archives, starting a restore, applying or discarding what it set aside. */
export function withBackupRestores() {
  return signalStoreFeature(
    type<SignalStoreFeatureType<typeof withBackupsCore>>(),
    withState<BackupRestoresState>(initialBackupRestoresState),
    withMethods(
      (store, backupsService = inject(BackupsService), translator = inject(Translator)) => ({
        /**
         * The archives for the restore dialog, read again from the disk first through the person's
         * sudo (the saved lists are a run behind after a recovery); without it, the saved list.
         * Another item opened meanwhile wins.
         */
        loadArchives: rxMethod<string>(
          pipe(
            tap((itemId) => patchState(store, { archives: { itemId, list: null } })),
            switchMap((itemId) =>
              backupsService.refreshArchives().pipe(
                catchError((error: unknown) => {
                  // A backup running holds the repository: its saved list is just as new.
                  if (apiErrorCode(error) !== 'busy')
                    store._failed('backups.restore.refreshFailed', error);
                  return of(null);
                }),
                switchMap(() => backupsService.archives(itemId)),
                tap(({ archives }) => patchState(store, { archives: { itemId, list: archives } })),
                catchError(() => {
                  patchState(store, { archives: { itemId, list: [] } });
                  return EMPTY;
                }),
              ),
            ),
          ),
        ),

        /** Starts a restore (already confirmed); its progress arrives through the topic. */
        restore: rxMethod<RestoreChoice>(
          pipe(
            exhaustMap((choice) =>
              store
                ._act('restore', 'backups.restore.failed', () => backupsService.restore(choice))
                .pipe(
                  tap(() => {
                    toast.success(translator.t('backups.restore.started'));
                    store.reload();
                  }),
                ),
            ),
          ),
        ),

        /** After a restore back where it was: the app's restored files applied, as the person. */
        applyRestored: rxMethod<BackupRestore>(
          pipe(
            mergeMap((restore) => {
              const project = store.plan()?.items.find((i) => i.id === restore.itemId)?.project;
              const folder = store.apps().find((a) => a.name === project)?.folder;
              if (!folder) {
                toast.error(translator.t('backups.restore.applyFailed'));
                return EMPTY;
              }
              return store
                ._act(`apply:${restore.id}`, 'backups.restore.applyFailed', () =>
                  backupsService.applyRestored(restore.id, folder),
                )
                .pipe(
                  tap(() => {
                    toast.success(translator.t('backups.restore.applyStarted'));
                    store.reload();
                  }),
                );
            }),
          ),
        ),

        discardPrevious: rxMethod<string>(
          pipe(
            mergeMap((restoreId) =>
              store
                ._act(`discard:${restoreId}`, 'backups.restore.discardFailed', () =>
                  backupsService.discardPrevious(restoreId),
                )
                .pipe(
                  tap(() => {
                    toast.success(translator.t('backups.restore.discarded'));
                    store.reload();
                  }),
                ),
            ),
          ),
        ),
      }),
    ),
  );
}
