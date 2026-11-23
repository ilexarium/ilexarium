import { computed, inject } from '@angular/core';
import {
  patchState,
  signalStore,
  withComputed,
  withHooks,
  withMethods,
  withState,
} from '@ngrx/signals';
import { DISK_MOUNT_ROOT, type DiskMountRequest, type DisksStatus } from '@ilex/shared';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import { toast } from '@spartan-ng/brain/sonner';
import { catchError, EMPTY, firstValueFrom, map, mergeMap, pipe, switchMap, tap } from 'rxjs';
import { DisksApi } from '../../../core/disks/disks-api';
import { LinuxSessionStore } from '../../../core/linux/linux-session-store';
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
    /** Folders under /mnt in use (connected disks or not): the mount dialog's suggestion avoids them. */
    takenNames: computed(() => {
      const status = store.status();
      if (!status) return [];
      return [
        ...status.disks.flatMap((d) => d.partitions.map((p) => p.mountPoint)),
        ...status.disconnected.map((d) => d.mountPoint),
      ]
        .filter((path): path is string => path?.startsWith(`${DISK_MOUNT_ROOT}/`) ?? false)
        .map((path) => path.slice(DISK_MOUNT_ROOT.length + 1));
    }),
  })),
  withMethods(
    (
      store,
      disksApi = inject(DisksApi),
      linuxSessionStore = inject(LinuxSessionStore),
      translator = inject(Translator),
    ) => {
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

        /**
         * Mounts a disk as the person (their sudo); rejects with the server's error (the dialog
         * puts it on its field). False when a prompt was closed.
         */
        async mount(request: DiskMountRequest): Promise<boolean> {
          const answer = await linuxSessionStore.asPerson(() =>
            firstValueFrom(disksApi.mount(request)),
          );
          if (!answer) return false;
          toast.success(translator.t('disks.mounted', { path: answer.mountPoint }));
          load();
          return true;
        },

        /** Unmounts (already confirmed) — or forgets a disk that isn't connected. */
        unmount: rxMethod<UnmountTarget>(
          pipe(
            mergeMap(({ mountPoint, connected }) => {
              if (store.pending().includes(mountPoint)) return EMPTY;
              return linuxSessionStore
                .asPerson$(() => disksApi.unmount(mountPoint).pipe(map(() => true)))
                .pipe(
                  tap({
                    subscribe: () =>
                      patchState(store, { pending: [...store.pending(), mountPoint] }),
                    next: (done) => {
                      if (!done) return;
                      toast.success(
                        translator.t(connected ? 'disks.unmounted' : 'disks.forgotten'),
                      );
                      load();
                    },
                    finalize: () =>
                      patchState(store, {
                        pending: store.pending().filter((n) => n !== mountPoint),
                      }),
                  }),
                  catchError((error: unknown) => {
                    toast.error(translator.t('disks.unmountFailed'), {
                      description: translator.t(...apiErrorText(error)),
                    });
                    return EMPTY;
                  }),
                );
            }),
          ),
        ),
      };
    },
  ),
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
