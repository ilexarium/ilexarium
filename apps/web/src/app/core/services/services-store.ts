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

/** Global, so the list is there at once when coming back to a page. */
export const ServicesStore = signalStore(
  { providedIn: 'root' },
  withState<ServicesState>(initialState),
  withMethods((store, realtimeService = inject(RealtimeService)) => ({
    watch(): () => void {
      return realtimeService.subscribe('services', (message) => {
        if (message.event === 'services:snapshot' || message.event === 'services:update') {
          patchState(store, { services: message.data.services });
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
