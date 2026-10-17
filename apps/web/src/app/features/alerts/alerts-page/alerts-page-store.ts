import { inject } from '@angular/core';
import { patchState, signalStore, withHooks, withMethods, withState } from '@ngrx/signals';
import { toast } from '@spartan-ng/brain/sonner';
import { AlertsApi } from '../../../core/alerts/alerts-api';
import { AlertsStore } from '../../../core/alerts/alerts-store';
import { AuthStore } from '../../../core/auth/auth-store';
import { Translator } from '../../../core/i18n/translator';
import { apiErrorText } from '../../../shared/forms/submission-errors';

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
  withMethods(
    (
      store,
      api = inject(AlertsApi),
      alerts = inject(AlertsStore),
      auth = inject(AuthStore),
      translator = inject(Translator),
    ) => ({
      async load(): Promise<void> {
        try {
          alerts.fill(await api.status());
        } catch {
          // The topic brings them when it can; the page shows its loading state until then.
        }
      },

      /** Stops an open alert's reminders. */
      async acknowledge(id: string): Promise<void> {
        patchState(store, { pending: [...store.pending(), id] });
        try {
          await api.acknowledge(id);
          alerts.acknowledged(id, auth.user()?.username ?? '', new Date().toISOString());
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
  withHooks((store, alerts = inject(AlertsStore)) => ({
    onInit() {
      if (!alerts.loaded()) void store.load();
    },
  })),
);
