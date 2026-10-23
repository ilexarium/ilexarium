import { computed, effect, inject } from '@angular/core';
import {
  patchState,
  signalStore,
  withComputed,
  withHooks,
  withMethods,
  withState,
} from '@ngrx/signals';
import type { BackupsStatus } from '@laris/shared';
import { AuthStore } from '../auth/auth-store';
import { RealtimeService } from '../realtime/realtime-service';

interface BackupsState {
  /** Null until the first snapshot. */
  status: BackupsStatus | null;
}

const initialState: BackupsState = { status: null };

/**
 * The backups' status, fed by the `backups` topic for the whole signed-in session (the shell
 * watches it): the warnings behind the badge on "Backups" and the dashboard notice, each
 * service's last backup for its card, whether a plan exists (the install form's checkbox), the
 * running run's live progress and the latest restore. Reset on sign-out like every global store.
 */
export const BackupsStore = signalStore(
  { providedIn: 'root' },
  withState<BackupsState>(initialState),
  withComputed((store) => ({
    configured: computed(() => store.status()?.configured ?? false),
    warnings: computed(() => store.status()?.warnings ?? []),
    running: computed(() => store.status()?.running ?? null),
    /** Each backed-up service's last backup, by service id. */
    services: computed(() => {
      const items = store.status()?.items ?? [];
      return new Map(
        items
          .filter((item) => item.kind === 'service' && item.serviceId)
          .map((item) => [item.serviceId!, item]),
      );
    }),
  })),
  withMethods((store, realtimeService = inject(RealtimeService)) => ({
    /** Subscribes until the returned function is called. */
    watch(): () => void {
      return realtimeService.subscribe('backups', (message) => {
        if (message.event === 'backups:snapshot' || message.event === 'backups:update') {
          patchState(store, { status: message.data });
        }
      });
    },
  })),
  withHooks((store, authStore = inject(AuthStore)) => ({
    onInit() {
      effect(() => {
        if (!authStore.isAuthenticated()) patchState(store, initialState);
      });
    },
  })),
);
