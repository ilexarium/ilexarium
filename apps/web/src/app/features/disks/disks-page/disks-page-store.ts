import { computed, inject } from '@angular/core';
import {
  patchState,
  signalStore,
  withComputed,
  withHooks,
  withMethods,
  withState,
} from '@ngrx/signals';
import type { DiskMountRequest, DisksStatus } from '@laris/shared';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import { toast } from '@spartan-ng/brain/sonner';
import { catchError, EMPTY, firstValueFrom, finalize, mergeMap, pipe, switchMap, tap } from 'rxjs';
import { DisksApi } from '../../../core/disks/disks-api';
import { Translator } from '../../../core/i18n/translator';
import { RealtimeService } from '../../../core/realtime/realtime-service';
import { apiErrorText } from '../../../shared/forms/submission-errors';
import type { UnmountTarget } from '../disks.model';

interface DisksPageState {
  /** Null until loaded. */
  status: DisksStatus | null;
  failed: boolean;
  /** Names being unmounted, for pending buttons. */
  pending: string[];
}

const initialState: DisksPageState = { status: null, failed: false, pending: [] };

/**
 * The Disks page's data, provided by the page and gone with it: the disks (the `disks` topic
 * keeps them current — a disk plugged in appears at once), mounting and unmounting with their
 * toasts.
 */
export const DisksPageStore = signalStore(
  withState<DisksPageState>(initialState),
  withComputed((store) => ({
    /** Names in use for disks mounted here (connected or not): the mount dialog avoids them. */
    takenNames: computed(() => {
      const status = store.status();
      if (!status) return [];
      return [
        ...status.disks.flatMap((d) => d.partitions.map((p) => p.managedName)),
        ...status.disconnected.map((d) => d.name),
      ].filter((name): name is string => name !== null);
    }),
  })),
  withMethods((store, disksApi = inject(DisksApi), translator = inject(Translator)) => {
    // After a change too: the latest answer wins.
    const load = rxMethod<void>(
      pipe(
        switchMap(() =>
          disksApi.status().pipe(
            tap((status) => patchState(store, { status, failed: false })),
            catchError(() => {
              if (!store.status()) patchState(store, { failed: true });
              return EMPTY;
            }),
          ),
        ),
      ),
    );
    return {
      load,

      update(status: DisksStatus): void {
        patchState(store, { status, failed: false });
      },

      /** Mounts a disk; rejects with the server's error (the dialog puts it on its field). */
      async mount(request: DiskMountRequest): Promise<void> {
        const { mountPoint } = await firstValueFrom(disksApi.mount(request));
        toast.success(translator.t('disks.mounted', { path: mountPoint }));
        load();
      },

      /** Unmounts (already confirmed) — or forgets a disk that isn't connected. */
      unmount: rxMethod<UnmountTarget>(
        pipe(
          tap(({ name }) => patchState(store, { pending: [...store.pending(), name] })),
          mergeMap(({ name, connected }) =>
            disksApi.unmount(name).pipe(
              tap(() => {
                toast.success(translator.t(connected ? 'disks.unmounted' : 'disks.forgotten'));
                load();
              }),
              catchError((error: unknown) => {
                toast.error(translator.t('disks.unmountFailed'), {
                  description: translator.t(...apiErrorText(error)),
                });
                return EMPTY;
              }),
              finalize(() =>
                patchState(store, { pending: store.pending().filter((n) => n !== name) }),
              ),
            ),
          ),
        ),
      ),
    };
  }),
  withHooks((store, realtimeService = inject(RealtimeService)) => {
    let stop: (() => void) | null = null;
    return {
      onInit() {
        store.load();
        stop = realtimeService.subscribe('disks', (message) => {
          if (message.event === 'disks:snapshot' || message.event === 'disks:update') {
            store.update(message.data);
          }
        });
      },
      onDestroy() {
        stop?.();
      },
    };
  }),
);
