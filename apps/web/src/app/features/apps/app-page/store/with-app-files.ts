import { computed, inject, linkedSignal } from '@angular/core';
import {
  patchState,
  signalStoreFeature,
  type SignalStoreFeatureType,
  type,
  withComputed,
  withLinkedState,
  withMethods,
} from '@ngrx/signals';
import { APP_ERROR_CODES, parseEnv, setEnvValues } from '@ilex/shared';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import { EMPTY, exhaustMap, type Observable, pipe } from 'rxjs';
import { AppActionsService } from '../../../../core/apps/services/app-actions-service';
import { apiErrorCode } from '../../../../shared/forms/submission-errors';
import type { withAppDetails } from './with-app-details';
import type { withAppTask } from './with-app-task';

/**
 * Its two files being edited — the form and the editor — and saving them (applied as a task).
 * The edits start again from each read.
 */
export function withAppFiles() {
  return signalStoreFeature(
    type<
      SignalStoreFeatureType<typeof withAppDetails> & SignalStoreFeatureType<typeof withAppTask>
    >(),
    withLinkedState(({ details }) => ({
      compose: () => details()?.compose ?? '',
      env: () => details()?.env ?? '',
      /** Saved with other files on disk meanwhile: reload, or overwrite. */
      conflict: linkedSignal({ source: details, computation: () => false }),
    })),
    withComputed((store) => ({
      values: computed(() => parseEnv(store.env())),
      changed: computed(() => {
        const details = store.details();
        return !!details && (details.compose !== store.compose() || details.env !== store.env());
      }),
    })),
    withMethods((store, appActionsService = inject(AppActionsService)) => ({
      setValue(key: string, value: string): void {
        patchState(store, { env: setEnvValues(store.env(), { [key]: value }) });
      },

      setCompose(compose: string): void {
        patchState(store, { compose });
      },

      setEnv(env: string): void {
        patchState(store, { env });
      },

      /** Saves both files and applies them (refused when they changed on disk meanwhile). */
      _saveFiles(overwrite: boolean): Observable<unknown> {
        const details = store.details();
        if (!details) return EMPTY;
        patchState(store, { conflict: false });
        return store._startTask(
          'apps.save.failed',
          appActionsService.save(store.name(), {
            folder: details.folder,
            compose: store.compose(),
            env: store.env(),
            hash: details.hash,
            overwrite,
          }),
          (error) => {
            if (apiErrorCode(error) !== APP_ERROR_CODES.changedOnDisk) return false;
            patchState(store, { conflict: true });
            return true;
          },
        );
      },
    })),
    withMethods((store) => ({
      save: rxMethod<void>(pipe(exhaustMap(() => store._saveFiles(false)))),

      /** After "changed on disk": saved over what's there. */
      overwrite: rxMethod<void>(pipe(exhaustMap(() => store._saveFiles(true)))),
    })),
  );
}
