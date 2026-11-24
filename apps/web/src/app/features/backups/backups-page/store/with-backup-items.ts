import { computed, inject } from '@angular/core';
import {
  signalStoreFeature,
  type SignalStoreFeatureType,
  type,
  withComputed,
  withMethods,
} from '@ngrx/signals';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import { toast } from '@spartan-ng/brain/sonner';
import { concatMap, groupBy, mergeMap, type Observable, pipe, tap } from 'rxjs';
import { BackupsService } from '../../../../core/backups/services/backups-service';
import { Translator } from '../../../../core/i18n/translator';
import type { ItemChange, ItemRemoval } from '../../backups.model';
import type { withFolderPicker } from './with-folder-picker';

/** What's backed up: adding apps and folders, changing and removing items, backing up now. */
export function withBackupItems() {
  return signalStoreFeature(
    type<SignalStoreFeatureType<typeof withFolderPicker>>(),
    withComputed((store) => ({
      /** Apps that aren't in the plan yet. */
      addable: computed(() => {
        const inPlan = new Set(store.rows().active.map((r) => r.item.project));
        return store.apps().filter((app) => !inPlan.has(app.name));
      }),

      /** The item whose side sheet is open, as it is now; null once it's gone from the plan. */
      sheetRow: computed(
        () => store.rows().active.find((r) => r.item.id === store.sheetItemId()) ?? null,
      ),

      /** The item being backed up right now. */
      runningItemId: computed(
        () => store.running()?.items.find((i) => i.state === 'running')?.itemId ?? null,
      ),
    })),
    withMethods(
      (store, backupsService = inject(BackupsService), translator = inject(Translator)) => ({
        _runNow(itemId: string | undefined): Observable<unknown> {
          return store
            ._act(itemId ? `run:${itemId}` : 'run', 'backups.run.failed', () =>
              backupsService.runNow(itemId),
            )
            .pipe(tap(() => toast.success(translator.t('backups.run.started'))));
        },
      }),
    ),
    withMethods((store, backupsService = inject(BackupsService)) => ({
      /** The whole plan now. */
      runNow: rxMethod<void>(pipe(mergeMap(() => store._runNow(undefined)))),

      /** One item now (beside the whole plan's run: each its own pending button). */
      runItemNow: rxMethod<string>(pipe(mergeMap((itemId) => store._runNow(itemId)))),

      addApp: rxMethod<string>(
        pipe(
          mergeMap((name) =>
            store
              ._act(`add:${name}`, 'backups.items.addFailed', () =>
                backupsService.addApp(store._app(name)),
              )
              .pipe(tap(() => store.reload())),
          ),
        ),
      ),

      addFolder: rxMethod<string>(
        pipe(
          mergeMap((path) =>
            store
              ._act(`add:${path}`, 'backups.items.addFailed', () => backupsService.addFolder(path))
              .pipe(
                tap(() => {
                  store.closeBrowser();
                  store.reload();
                }),
              ),
          ),
        ),
      ),

      /** Each item's changes in the order made; items side by side. */
      changeItem: rxMethod<ItemChange>(
        pipe(
          groupBy(({ itemId }) => itemId),
          mergeMap((changes) =>
            changes.pipe(
              concatMap(({ itemId, change }) =>
                store
                  ._act(`folders:${itemId}`, 'backups.items.foldersFailed', () =>
                    backupsService.updateItem(itemId, change),
                  )
                  .pipe(tap(() => store.reload())),
              ),
            ),
          ),
        ),
      ),

      /** Out of the plan (already confirmed); `deleteArchives` deletes its backups too. */
      removeItem: rxMethod<ItemRemoval>(
        pipe(
          mergeMap(({ itemId, deleteArchives }) =>
            store
              ._act(
                `remove:${itemId}`,
                deleteArchives ? 'backups.items.deleteFailed' : 'backups.items.removeFailed',
                () => backupsService.removeItem(itemId, deleteArchives),
              )
              .pipe(tap(() => store.reload())),
          ),
        ),
      ),
    })),
  );
}
