import { effect, inject } from '@angular/core';
import { patchState, signalStore, withHooks, withMethods, withState } from '@ngrx/signals';
import type { InstalledService } from '@laris/shared';
import { AuthStore } from '../auth/auth-store';
import { RealtimeService } from '../realtime/realtime-service';

interface ServicesState {
  /** Null until the first snapshot. */
  services: InstalledService[] | null;
}

const initialState: ServicesState = { services: null };

/**
 * The installed services and their running job, fed by the `services` topic while a page
 * `watch()`es it (the server pushes every change). Global, so the list is there at once when
 * coming back; reset on sign-out like every global store.
 */
export const ServicesStore = signalStore(
  { providedIn: 'root' },
  withState<ServicesState>(initialState),
  withMethods((store, realtime = inject(RealtimeService)) => ({
    /** Subscribes until the returned function is called. */
    watch(): () => void {
      return realtime.subscribe('services', (message) => {
        if (message.event === 'services:snapshot' || message.event === 'services:update') {
          patchState(store, { services: message.data.services });
        }
      });
    },
  })),
  withHooks((store, auth = inject(AuthStore)) => ({
    onInit() {
      effect(() => {
        if (!auth.isAuthenticated()) patchState(store, initialState);
      });
    },
  })),
);
