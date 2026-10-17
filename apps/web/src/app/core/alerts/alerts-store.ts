import { computed, effect, inject } from '@angular/core';
import {
  patchState,
  signalStore,
  withComputed,
  withHooks,
  withMethods,
  withState,
} from '@ngrx/signals';
import type { AlertsStatus } from '@homelab/shared';
import { AuthStore } from '../auth/auth-store';
import { RealtimeService } from '../realtime/realtime-service';

interface AlertsState {
  /** Null until the first snapshot. */
  status: AlertsStatus | null;
}

const initialState: AlertsState = { status: null };

/**
 * The health alerts (docs/plans/health_alerts.md), fed by the `alerts` topic for the whole
 * signed-in session (the shell watches it): the open alerts behind the bell and the dashboard
 * notice, recently closed ones and the last delivery problem for the Alerts page. Reset on
 * sign-out like every global store.
 */
export const AlertsStore = signalStore(
  { providedIn: 'root' },
  withState<AlertsState>(initialState),
  withComputed((store) => ({
    loaded: computed(() => store.status() !== null),
    /** Critical first, then newest first. */
    open: computed(() => store.status()?.open ?? []),
    closed: computed(() => store.status()?.closed ?? []),
    deliveryFailure: computed(() => store.status()?.deliveryFailure ?? null),
  })),
  withMethods((store, realtime = inject(RealtimeService)) => ({
    /** Subscribes until the returned function is called. */
    watch(): () => void {
      return realtime.subscribe('alerts', (message) => {
        if (message.event === 'alerts:snapshot' || message.event === 'alerts:update') {
          patchState(store, { status: message.data });
        }
      });
    },

    /** A newer status from the server (after acknowledging, before the topic says so). */
    update(status: AlertsStatus): void {
      patchState(store, { status });
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
