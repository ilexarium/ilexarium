import { computed, effect, inject } from '@angular/core';
import {
  patchState,
  signalStore,
  withComputed,
  withHooks,
  withMethods,
  withState,
} from '@ngrx/signals';
import type { AlertsStatus } from '@laris/shared';
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
  withMethods((store, realtimeService = inject(RealtimeService)) => ({
    /** Subscribes until the returned function is called. */
    watch(): () => void {
      return realtimeService.subscribe('alerts', (message) => {
        if (message.event === 'alerts:snapshot' || message.event === 'alerts:update') {
          patchState(store, { status: message.data });
        }
      });
    },

    /** The status from `GET /api/alerts`: only until the topic has answered (its news is newer). */
    fill(status: AlertsStatus): void {
      if (!store.status()) patchState(store, { status });
    },

    /** Acknowledged here: shown at once; the topic's next update says the same. */
    acknowledged(id: string, by: string, at: string): void {
      const status = store.status();
      if (!status) return;
      patchState(store, {
        status: {
          ...status,
          open: status.open.map((alert) =>
            alert.id === id ? { ...alert, acknowledgedAt: at, acknowledgedBy: by } : alert,
          ),
        },
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
