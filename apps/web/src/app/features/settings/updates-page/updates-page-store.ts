import { computed, inject } from '@angular/core';
import {
  patchState,
  signalStore,
  withComputed,
  withHooks,
  withMethods,
  withState,
} from '@ngrx/signals';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import { toast } from '@spartan-ng/brain/sonner';
import { catchError, concatMap, EMPTY, exhaustMap, map, pipe, tap } from 'rxjs';
import { Translator } from '../../../core/i18n/translator';
import { LinuxSessionStore } from '../../../core/linux/linux-session-store';
import { RealtimeService } from '../../../core/realtime/realtime-service';
import { UpdatesApi } from '../../../core/updates/updates-api';
import { UpdatesStore } from '../../../core/updates/updates-store';
import { apiErrorText } from '../../../shared/forms/submission-errors';
import { OFFLINE_PHASES } from './updates-page.constants';

interface UpdatesPageState {
  failed: boolean;
  checking: boolean;
  starting: boolean;
}

/**
 * Settings → Updates' data, provided by the page and gone with it: the status comes from the
 * global UpdatesStore (the `updates` topic, the whole session); checking, the switch and starting
 * an update — through the person's sudo — happen here, with their toasts.
 */
export const UpdatesPageStore = signalStore(
  withState<UpdatesPageState>({ failed: false, checking: false, starting: false }),
  withComputed(
    (store, updatesStore = inject(UpdatesStore), realtimeService = inject(RealtimeService)) => ({
      status: updatesStore.status,
      job: updatesStore.job,
      running: updatesStore.running,
      /** The app is down for the update: its connection drops and comes back as the new version. */
      restarting: computed(() => {
        const job = updatesStore.job();
        if (!job || job.done) return false;
        return (
          (job.phase !== null && OFFLINE_PHASES.includes(job.phase)) ||
          realtimeService.status() !== 'live'
        );
      }),
    }),
  ),
  withMethods(
    (
      store,
      updatesApi = inject(UpdatesApi),
      updatesStore = inject(UpdatesStore),
      linuxSessionStore = inject(LinuxSessionStore),
      translator = inject(Translator),
    ) => ({
      // Only until the topic has answered (its news is newer).
      load: rxMethod<void>(
        pipe(
          exhaustMap(() =>
            updatesApi.status().pipe(
              tap((status) => {
                if (!updatesStore.status()) updatesStore.update(status);
                patchState(store, { failed: false });
              }),
              catchError(() => {
                if (!updatesStore.status()) patchState(store, { failed: true });
                return EMPTY;
              }),
            ),
          ),
        ),
      ),

      check: rxMethod<void>(
        pipe(
          exhaustMap(() =>
            updatesApi.check().pipe(
              tap({
                subscribe: () => patchState(store, { checking: true }),
                next: (status) => {
                  updatesStore.update(status);
                  if (status.checkError)
                    toast.error(translator.t(`updates.checkError.${status.checkError}`));
                  else if (!status.available) toast.success(translator.t('updates.upToDate'));
                },
                finalize: () => patchState(store, { checking: false }),
              }),
              catchError((error: unknown) => {
                toast.error(translator.t('updates.checkFailed'), {
                  description: translator.t(...apiErrorText(error)),
                });
                return EMPTY;
              }),
            ),
          ),
        ),
      ),

      /** Each switch in the order made. */
      setCheckAutomatically: rxMethod<boolean>(
        pipe(
          concatMap((checkAutomatically) =>
            updatesApi.setCheckAutomatically(checkAutomatically).pipe(
              tap(() => {
                const status = updatesStore.status();
                if (status) updatesStore.update({ ...status, checkAutomatically });
              }),
              catchError((error: unknown) => {
                toast.error(translator.t('updates.settingFailed'), {
                  description: translator.t(...apiErrorText(error)),
                });
                return EMPTY;
              }),
            ),
          ),
        ),
      ),

      /** Starts the update (already confirmed) as the person: their sudo password if it's locked. */
      start: rxMethod<string>(
        pipe(
          exhaustMap((version) =>
            linuxSessionStore
              .asPerson$(() => updatesApi.start(version).pipe(map(() => true)))
              .pipe(
                tap({
                  subscribe: () => patchState(store, { starting: true }),
                  next: (started) => {
                    if (started) toast.success(translator.t('updates.started', { version }));
                  },
                  finalize: () => patchState(store, { starting: false }),
                }),
                catchError((error: unknown) => {
                  toast.error(translator.t('updates.startFailed'), {
                    description: translator.t(...apiErrorText(error)),
                  });
                  return EMPTY;
                }),
              ),
          ),
        ),
      ),
    }),
  ),
  withHooks({
    onInit(store) {
      store.load();
    },
  }),
);
