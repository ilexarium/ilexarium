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
import type { BackupPlanUpdate, BackupSetupRequest } from '@ilex/shared';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import { toast } from '@spartan-ng/brain/sonner';
import { catchError, EMPTY, exhaustMap, firstValueFrom, lastValueFrom, pipe, tap } from 'rxjs';
import { BackupsService } from '../../../../core/backups/services/backups-service';
import { Translator } from '../../../../core/i18n/translator';
import type { BackupsHeadline } from '../../backups.model';
import type { BackupPlanState } from './backups-page-store.model';
import { initialBackupPlanState } from './backups-page-store.constants';
import type { withBackupsCore } from './with-backups-core';

/** Setting backups up, the plan's settings and disks, the passphrase, and how backups stand. */
export function withBackupPlan() {
  return signalStoreFeature(
    type<SignalStoreFeatureType<typeof withBackupsCore>>(),
    withState<BackupPlanState>(initialBackupPlanState),
    withComputed((store) => ({
      /** Null until the status and the plan are known. */
      headline: computed((): BackupsHeadline | null => {
        const status = store.status();
        if (!status || !store.plan()) return null;
        if (status.running) {
          const { items } = status.running;
          return {
            kind: 'running',
            done: items.filter((i) => i.state === 'done').length,
            total: items.length,
          };
        }
        const failed = store
          .rows()
          .active.filter((r) => r.item.lastResult?.status === 'failed').length;
        // A failed item already says the last run failed. Failed items show on their cards, not
        // in the warnings band, so the count can be more than the band lists.
        const warnings = status.warnings.filter((w) => !(w === 'lastRunFailed' && failed > 0));
        const count = failed + warnings.length;
        if (count > 0) return { kind: 'attention', count };
        const fresh = store.rows().active.some((r) => r.item.lastSuccessAt === null);
        return status.lastSuccessAt && !fresh
          ? { kind: 'allGood', at: status.lastSuccessAt }
          : { kind: 'never' };
      }),
    })),
    withMethods(
      (store, backupsService = inject(BackupsService), translator = inject(Translator)) => ({
        /** The disks a backup can go to. */
        _loadDestinations: rxMethod<void>(
          pipe(
            exhaustMap(() =>
              backupsService.destinations().pipe(
                tap(({ destinations }) => patchState(store, { destinations })),
                catchError(() => {
                  patchState(store, { destinations: [] });
                  return EMPTY;
                }),
              ),
            ),
          ),
        ),

        /** The disks again (the Restore Ilexarium dialog: one may have been mounted meanwhile). */
        loadDestinations: rxMethod<void>(
          pipe(
            exhaustMap(() =>
              backupsService.destinations().pipe(
                tap(({ destinations }) => patchState(store, { destinations })),
                // A failure mustn't look like "no disks": the list stays as it was.
                catchError(() => EMPTY),
              ),
            ),
          ),
        ),

        /**
         * Sets backups up, as the person, with these apps (their templates' presets) and folders;
         * rejects with the server's error (the form puts it on its fields).
         */
        async setup(
          settings: Omit<BackupSetupRequest, 'items'>,
          apps: string[],
          folders: string[],
        ): Promise<void> {
          const answer = await firstValueFrom(
            backupsService.setup(
              settings,
              apps.map((name) => store._app(name)),
              folders,
            ),
          );
          if (!answer) return;
          patchState(store, { passphrase: answer.passphrase, passphraseFirst: true });
          // The form stays busy until the plan shows.
          await lastValueFrom(store._loadPlan(), { defaultValue: undefined });
          toast.success(translator.t('backups.setup.done'));
        },

        /** Saves schedule, retention or disk, as the person; rejects with the server's error. */
        async updatePlan(update: BackupPlanUpdate): Promise<void> {
          const plan = await firstValueFrom(backupsService.updatePlan(update));
          if (!plan) return;
          patchState(store, { plan });
          toast.success(translator.t('backups.settings.saved'));
        },

        /** The passphrase was saved by the user: it goes from the page. */
        hidePassphrase(): void {
          patchState(store, { passphrase: null, passphraseFirst: false });
        },

        /** "Show again": through the person's sudo. */
        showPassphrase: rxMethod<void>(
          pipe(
            exhaustMap(() =>
              backupsService.passphrase().pipe(
                tap((answer) => {
                  if (answer)
                    patchState(store, { passphrase: answer.passphrase, passphraseFirst: false });
                }),
                catchError((error: unknown) => {
                  store._failed('backups.passphrase.failed', error);
                  return EMPTY;
                }),
              ),
            ),
          ),
        ),
      }),
    ),
  );
}
