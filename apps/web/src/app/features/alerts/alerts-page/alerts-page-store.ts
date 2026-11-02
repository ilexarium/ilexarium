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
import { catchError, EMPTY, exhaustMap, firstValueFrom, pipe, tap } from 'rxjs';
import { AlertsApi } from '../../../core/alerts/alerts-api';
import { AlertsStore } from '../../../core/alerts/alerts-store';
import { AuthStore } from '../../../core/auth/auth-store';
import { Translator } from '../../../core/i18n/translator';
import { apiErrorText } from '../../../shared/forms/submission-errors';
import type { AlertCounts } from '../alerts.model';

interface AlertsPageState {
  /** Alerts being acknowledged, for pending buttons. */
  pending: string[];
}

/**
 * The Alerts page's actions, provided by the page and gone with it. The alerts themselves are the
 * global `AlertsStore`'s (the shell follows the `alerts` topic all session); this loads them if
 * the topic hasn't answered yet and acknowledges one, with its toast.
 */
export const AlertsPageStore = signalStore(
  withState<AlertsPageState>({ pending: [] }),
  withComputed((store, alertsStore = inject(AlertsStore)) => ({
    /** For the headline: "1 critical, 2 warnings". */
    counts: computed((): AlertCounts => {
      const open = alertsStore.open();
      const critical = open.filter((a) => a.severity === 'critical').length;
      return { critical, warning: open.length - critical };
    }),
  })),
  withMethods(
    (
      store,
      alertsApi = inject(AlertsApi),
      alertsStore = inject(AlertsStore),
      authStore = inject(AuthStore),
      translator = inject(Translator),
    ) => ({
      load: rxMethod<void>(
        pipe(
          exhaustMap(() =>
            alertsApi.status().pipe(
              tap((status) => alertsStore.fill(status)),
              // The topic brings them when it can; the page shows its loading state until then.
              catchError(() => EMPTY),
            ),
          ),
        ),
      ),

      /** Stops an open alert's reminders. */
      async acknowledge(id: string): Promise<void> {
        patchState(store, { pending: [...store.pending(), id] });
        try {
          await firstValueFrom(alertsApi.acknowledge(id));
          alertsStore.acknowledged(id, authStore.user()?.username ?? '', new Date().toISOString());
        } catch (error) {
          toast.error(translator.t('alerts.acknowledgeFailed'), {
            description: translator.t(...apiErrorText(error)),
          });
        } finally {
          patchState(store, { pending: store.pending().filter((p) => p !== id) });
        }
      },
    }),
  ),
  withHooks((store, alertsStore = inject(AlertsStore)) => ({
    onInit() {
      if (!alertsStore.loaded()) store.load();
    },
  })),
);
