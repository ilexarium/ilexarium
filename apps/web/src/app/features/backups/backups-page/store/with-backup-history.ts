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
import { catchError, EMPTY, mergeMap, pipe, tap } from 'rxjs';
import { BackupsService } from '../../../../core/backups/services/backups-service';
import { runAdded } from '../../backup-runs';
import type { BackupHistoryState } from './backups-page-store.model';
import { initialBackupHistoryState } from './backups-page-store.constants';
import type { withBackupsCore } from './with-backups-core';

/** The history: what each run added, and a run's output when opened. */
export function withBackupHistory() {
  return signalStoreFeature(
    type<SignalStoreFeatureType<typeof withBackupsCore>>(),
    withState<BackupHistoryState>(initialBackupHistoryState),
    withComputed((store) => ({
      /** What each run added, oldest first, for the history's line. */
      sizeLine: computed(() => [...(store.runs() ?? [])].reverse().map(runAdded)),
    })),
    withMethods((store, backupsService = inject(BackupsService)) => ({
      loadOutput: rxMethod<string>(
        pipe(
          mergeMap((runId) =>
            backupsService.runOutput(runId).pipe(
              tap(({ output }) =>
                patchState(store, { outputs: { ...store.outputs(), [runId]: output } }),
              ),
              catchError(() => {
                patchState(store, { outputs: { ...store.outputs(), [runId]: [] } });
                return EMPTY;
              }),
            ),
          ),
        ),
      ),
    })),
  );
}
