import { computed, inject } from '@angular/core';
import {
  patchState,
  signalStoreFeature,
  withComputed,
  withMethods,
  withState,
} from '@ngrx/signals';
import { type BackupItem, catalogIconPath } from '@ilex/shared';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import { toast } from '@spartan-ng/brain/sonner';
import {
  catchError,
  concat,
  defer,
  EMPTY,
  filter,
  type Observable,
  pipe,
  switchMap,
  tap,
} from 'rxjs';
import { AppsStore } from '../../../../core/apps/apps-store';
import type { AppForBackup } from '../../../../core/backups/backups.model';
import { BackupsStore } from '../../../../core/backups/backups-store';
import { BackupsService } from '../../../../core/backups/services/backups-service';
import { Translator } from '../../../../core/i18n/translator';
import { apiErrorText } from '../../../../shared/forms/submission-errors';
import type { BackupsTab, ItemRow } from '../../backups.model';
import type { BackupsCoreState } from './backups-page-store.model';
import { initialBackupsCoreState } from './backups-page-store.constants';

/**
 * What every part of the page uses: the plan and its history, the live status, the apps, the
 * item rows, the tab and side sheet — and the helpers for actions and reloading.
 */
export function withBackupsCore() {
  return signalStoreFeature(
    withState<BackupsCoreState>(initialBackupsCoreState),
    withComputed((store, backupsStore = inject(BackupsStore), appsStore = inject(AppsStore)) => ({
      status: computed(() => backupsStore.status()),
      running: computed(() => backupsStore.running()),

      /** The apps Docker knows (live). */
      apps: computed(() => appsStore.apps() ?? []),

      /**
       * Each app's template icon, by name. Its own step, equal while the icons stay: Docker's
       * updates come every few seconds, and the cards needn't be built again for them.
       */
      icons: computed(
        () => {
          const templates = appsStore.templatesById();
          const icons = new Map<string, string>();
          for (const app of appsStore.apps() ?? []) {
            const id = app.template?.id;
            if (id && templates.has(id)) icons.set(app.name, catalogIconPath(id));
          }
          return icons;
        },
        {
          equal: (a, b) =>
            a.size === b.size && [...a].every(([name, icon]) => b.get(name) === icon),
        },
      ),
    })),
    withComputed((store) => ({
      /** The plan's items as shown: active ones and removed ones (backups kept). */
      rows: computed((): { active: ItemRow[]; removed: ItemRow[] } => {
        const icons = store.icons();
        const row = (item: BackupItem): ItemRow => ({
          item,
          name: item.project,
          icon: (item.project && icons.get(item.project)) || null,
        });
        const items = store.plan()?.items ?? [];
        return {
          active: items.filter((i) => !i.removed).map(row),
          removed: items.filter((i) => i.removed).map(row),
        };
      }),
    })),
    withMethods(
      (store, backupsService = inject(BackupsService), translator = inject(Translator)) => {
        const pending = (key: string, on: boolean) =>
          patchState(store, {
            pending: on ? [...store.pending(), key] : store.pending().filter((k) => k !== key),
          });
        /** A failure as a toast: what failed, and why in words. */
        const failed = (key: string, error: unknown, params: Record<string, unknown> = {}) =>
          toast.error(translator.t(key, params), {
            description: translator.t(...apiErrorText(error)),
          });
        return {
          _failed: failed,

          /** An app by name, as a backup item needs it (gone from Docker: just its name). */
          _app(name: string): AppForBackup {
            return (
              store.apps().find((a) => a.name === name) ?? { name, folder: null, template: null }
            );
          },

          _loadPlan(): Observable<unknown> {
            return backupsService.plan().pipe(
              tap(({ plan }) => patchState(store, { plan, loaded: true, failed: false })),
              catchError(() => {
                patchState(store, { loaded: true, failed: true });
                return EMPTY;
              }),
            );
          },

          /** Runs and restores; only once there is a plan (known when it's loaded). */
          _loadHistory(): Observable<unknown> {
            return defer(() => (store.plan() ? backupsService.history() : EMPTY)).pipe(
              tap(({ runs, restores }) => patchState(store, { runs, restores })),
              // The page shows the last known history; the next change tries again.
              catchError(() => EMPTY),
            );
          },

          /**
           * A change as the person with a pending marker (`request` gives null when a prompt was
           * dismissed); a failure is a toast. Emits once when done; nothing when refused, dismissed,
           * or the same action still runs.
           */
          _act(
            key: string,
            failureKey: string,
            request: () => Observable<true | null>,
            params: Record<string, unknown> = {},
          ): Observable<true> {
            return defer(() =>
              store.pending().includes(key)
                ? EMPTY
                : request().pipe(
                    tap({
                      subscribe: () => pending(key, true),
                      finalize: () => pending(key, false),
                    }),
                    catchError((error: unknown) => {
                      failed(failureKey, error, params);
                      return EMPTY;
                    }),
                    filter((done): done is true => done === true),
                  ),
            );
          },
        };
      },
    ),
    withMethods((store) => ({
      /**
       * The plan and its history again (after an action, after a change the topic pushed): one
       * pipeline, so the latest asked for wins.
       */
      reload: rxMethod<void>(
        pipe(switchMap(() => concat(store._loadPlan(), store._loadHistory()))),
      ),

      setTab(tab: BackupsTab): void {
        patchState(store, { tab });
      },

      openSheet(itemId: string): void {
        patchState(store, { sheetItemId: itemId });
      },

      closeSheet(): void {
        patchState(store, { sheetItemId: null });
      },
    })),
  );
}
