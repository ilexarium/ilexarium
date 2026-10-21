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
import { toast } from '@spartan-ng/brain/sonner';
import { DisksApi } from '../../../core/disks/disks-api';
import { Translator } from '../../../core/i18n/translator';
import { RealtimeService } from '../../../core/realtime/realtime-service';
import { apiErrorText } from '../../../shared/forms/submission-errors';

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
  withMethods((store, api = inject(DisksApi), translator = inject(Translator)) => ({
    async load(): Promise<void> {
      try {
        patchState(store, { status: await api.status(), failed: false });
      } catch {
        if (!store.status()) patchState(store, { failed: true });
      }
    },

    update(status: DisksStatus): void {
      patchState(store, { status, failed: false });
    },

    /** Mounts a disk; rejects with the server's error (the dialog puts it on its field). */
    async mount(request: DiskMountRequest): Promise<void> {
      const { mountPoint } = await api.mount(request);
      toast.success(translator.t('disks.mounted', { path: mountPoint }));
      await this.load();
    },

    /** Unmounts (already confirmed) — or forgets a disk that isn't connected. */
    async unmount(name: string, connected: boolean): Promise<void> {
      patchState(store, { pending: [...store.pending(), name] });
      try {
        await api.unmount(name);
        toast.success(translator.t(connected ? 'disks.unmounted' : 'disks.forgotten'));
        await this.load();
      } catch (error) {
        toast.error(translator.t('disks.unmountFailed'), {
          description: translator.t(...apiErrorText(error)),
        });
      } finally {
        patchState(store, { pending: store.pending().filter((n) => n !== name) });
      }
    },
  })),
  withHooks((store, realtime = inject(RealtimeService)) => {
    let stop: (() => void) | null = null;
    return {
      onInit() {
        void store.load();
        stop = realtime.subscribe('disks', (message) => {
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
