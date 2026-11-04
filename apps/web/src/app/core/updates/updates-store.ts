import { computed, effect, inject } from '@angular/core';
import {
  patchState,
  signalStore,
  withComputed,
  withHooks,
  withMethods,
  withState,
} from '@ngrx/signals';
import type { UpdatesStatus } from '@laris/shared';
import { AuthStore } from '../auth/auth-store';
import { RealtimeService } from '../realtime/realtime-service';
import { PAGE_RELOAD } from './page-reload';

interface UpdatesState {
  /** Null until the first snapshot. */
  status: UpdatesStatus | null;
  /** The version this page was loaded from (the first one the server named). */
  loadedVersion: string | null;
}

const initialState: UpdatesState = { status: null, loadedVersion: null };

/**
 * Laris's own updates (docs/plans/install_and_update.md), fed by the `updates` topic for the whole
 * signed-in session (the shell watches it): the badge on Settings → Updates, the dashboard's line,
 * a running update's progress. When the server comes back as another version (after an update),
 * the page reloads: this one's files are gone. Reset on sign-out like every global store.
 */
export const UpdatesStore = signalStore(
  { providedIn: 'root' },
  withState<UpdatesState>(initialState),
  withComputed((store) => ({
    available: computed(() => store.status()?.available ?? null),
    job: computed(() => store.status()?.job ?? null),
    running: computed(() => {
      const job = store.status()?.job;
      return job !== null && job !== undefined && job.done === null;
    }),
  })),
  withMethods((store, realtimeService = inject(RealtimeService), reload = inject(PAGE_RELOAD)) => {
    const update = (status: UpdatesStatus): void => {
      const loaded = store.loadedVersion();
      if (loaded !== null && loaded !== status.installed) {
        reload();
        return;
      }
      patchState(store, { status, loadedVersion: loaded ?? status.installed });
    };
    return {
      update,

      /** Subscribes until the returned function is called. */
      watch(): () => void {
        return realtimeService.subscribe('updates', (message) => {
          if (message.event === 'updates:snapshot' || message.event === 'updates:update') {
            update(message.data);
          }
        });
      },
    };
  }),
  withHooks((store, authStore = inject(AuthStore)) => ({
    onInit() {
      effect(() => {
        if (!authStore.isAuthenticated()) patchState(store, initialState);
      });
    },
  })),
);
