import { DOCUMENT, inject } from '@angular/core';
import {
  patchState,
  signalStoreFeature,
  type SignalStoreFeatureType,
  type,
  withMethods,
  withState,
} from '@ngrx/signals';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import { toast } from '@spartan-ng/brain/sonner';
import type { BackupRecoveryRequest } from '@ilex/shared';
import {
  catchError,
  EMPTY,
  exhaustMap,
  filter,
  map,
  of,
  pipe,
  switchMap,
  take,
  tap,
  timer,
} from 'rxjs';
import { RECOVERY_STORAGE_KEY } from '../../../../core/backups/backups.constants';
import { BackupsService } from '../../../../core/backups/services/backups-service';
import { Translator } from '../../../../core/i18n/translator';
import { writeStored } from '../../../../core/storage/browser-storage';
import { apiErrorCode, apiErrorText } from '../../../../shared/forms/submission-errors';
import type { BackupRecoveryState } from './backups-page-store.model';
import {
  initialBackupRecoveryState,
  RECOVERY_POLL_MS,
  RECOVERY_WAIT_MS,
} from './backups-page-store.constants';
import type { withBackupsCore } from './with-backups-core';

/**
 * Restoring Ilexarium from the backup disk (only while there's no plan): the backups found, the
 * passphrase checked, the start — then the wait while Ilexarium restarts. Its end is the session
 * going (the restored database doesn't have it: the sign-in page, told by `RECOVERY_STORAGE_KEY`),
 * or the failure its file reports. And the last recovery's notice, with its Dismiss.
 */
export function withBackupRecovery() {
  return signalStoreFeature(
    type<SignalStoreFeatureType<typeof withBackupsCore>>(),
    withState<BackupRecoveryState>(initialBackupRecoveryState),
    withMethods(
      (
        store,
        backupsService = inject(BackupsService),
        translator = inject(Translator),
        window = inject(DOCUMENT).defaultView,
      ) => {
        // Here a wrong passphrase is the typed one, not this server's file.
        const failedWith = (error: unknown) =>
          patchState(store, {
            recoveryStep: 'idle',
            recoveryError:
              apiErrorCode(error) === 'passphrase_invalid'
                ? translator.t('backups.recovery.wrongPassphrase')
                : translator.t(...apiErrorText(error)),
          });
        return {
          loadRecovery: rxMethod<void>(
            pipe(
              switchMap(() =>
                backupsService.recovery().pipe(
                  tap(({ recovery }) => patchState(store, { recovery })),
                  catchError(() => EMPTY),
                ),
              ),
            ),
          ),

          /** The backups on mounted disks, through the person's sudo. */
          findRecoveryBackups: rxMethod<void>(
            pipe(
              exhaustMap(() => {
                patchState(store, {
                  recoveryStep: 'finding',
                  recoveryFound: null,
                  recoveryError: null,
                });
                return backupsService.recoveryCheck({}).pipe(
                  tap((found) => patchState(store, { recoveryStep: 'idle', recoveryFound: found })),
                  catchError((error: unknown) => {
                    failedWith(error);
                    return EMPTY;
                  }),
                );
              }),
            ),
          ),

          /** The passphrase against a repository: its newest backups of Ilexarium. */
          checkRecoveryPassphrase: rxMethod<{ repository: string; passphrase: string }>(
            pipe(
              exhaustMap((request) => {
                patchState(store, { recoveryStep: 'checking', recoveryError: null });
                return backupsService.recoveryCheck(request).pipe(
                  tap((found) =>
                    patchState(store, {
                      recoveryStep: 'idle',
                      recoveryFound: found ?? store.recoveryFound(),
                    }),
                  ),
                  catchError((error: unknown) => {
                    failedWith(error);
                    return EMPTY;
                  }),
                );
              }),
            ),
          ),

          /**
           * Starts it (confirmed in the dialog), then waits: answers fail while Ilexarium restarts;
           * a 401 ends the page (the session is gone: restored); its file saying it failed ends
           * the wait here.
           */
          recover: rxMethod<BackupRecoveryRequest>(
            pipe(
              exhaustMap((request) => {
                patchState(store, { recoveryStep: 'starting', recoveryError: null });
                return backupsService.recover(request).pipe(
                  switchMap((started) => {
                    if (!started) {
                      patchState(store, { recoveryStep: 'idle' });
                      return EMPTY;
                    }
                    writeStored(window, RECOVERY_STORAGE_KEY, String(Date.now()));
                    patchState(store, { recoveryStep: 'waiting' });
                    return timer(RECOVERY_POLL_MS, RECOVERY_POLL_MS).pipe(
                      exhaustMap((tick) =>
                        tick * RECOVERY_POLL_MS > RECOVERY_WAIT_MS
                          ? of({ timedOut: true, recovery: null })
                          : backupsService.recovery().pipe(
                              map(({ recovery }) => ({ timedOut: false, recovery })),
                              catchError(() => of(null)),
                            ),
                      ),
                      filter(
                        (seen) =>
                          seen !== null &&
                          (seen.timedOut ||
                            (seen.recovery?.id === started.recoveryId &&
                              seen.recovery.status === 'failed')),
                      ),
                      take(1),
                      tap((seen) => {
                        writeStored(window, RECOVERY_STORAGE_KEY, '');
                        patchState(store, {
                          recoveryStep: 'failed',
                          recovery: seen!.recovery ?? store.recovery(),
                          recoveryError: translator.t(
                            seen!.timedOut
                              ? 'backups.recovery.tooLong'
                              : `errors.${seen!.recovery!.errorCode ?? 'recovery_failed'}`,
                          ),
                        });
                      }),
                    );
                  }),
                  catchError((error: unknown) => {
                    failedWith(error);
                    return EMPTY;
                  }),
                );
              }),
            ),
          ),

          dismissRecovery: rxMethod<void>(
            pipe(
              exhaustMap(() =>
                backupsService.dismissRecovery().pipe(
                  tap(() => {
                    const recovery = store.recovery();
                    if (recovery) patchState(store, { recovery: { ...recovery, dismissed: true } });
                  }),
                  catchError((error: unknown) => {
                    toast.error(translator.t('backups.recovery.dismissFailed'), {
                      description: translator.t(...apiErrorText(error)),
                    });
                    return EMPTY;
                  }),
                ),
              ),
            ),
          ),

          /** The dialog closed: nothing of it kept (the passphrase stays in the dialog only). */
          resetRecovery(): void {
            if (['starting', 'waiting'].includes(store.recoveryStep())) return;
            patchState(store, {
              recoveryStep: 'idle',
              recoveryFound: null,
              recoveryError: null,
            });
          },
        };
      },
    ),
  );
}
