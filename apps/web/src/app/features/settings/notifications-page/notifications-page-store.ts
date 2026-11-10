import { inject } from '@angular/core';
import { patchState, signalStore, withHooks, withMethods, withState } from '@ngrx/signals';
import type {
  AlertChannel,
  AlertChannelsResponse,
  EmailChannelUpdate,
  NtfyChannelUpdate,
} from '@ilex/shared';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import { toast } from '@spartan-ng/brain/sonner';
import { catchError, EMPTY, firstValueFrom, pipe, switchMap, tap } from 'rxjs';
import { AlertsApi } from '../../../core/alerts/alerts-api';
import { Translator } from '../../../core/i18n/translator';
import { apiErrorText } from '../../../shared/forms/submission-errors';

interface NotificationsPageState {
  /** Null until loaded. */
  channels: AlertChannelsResponse | null;
  failed: boolean;
  /** Channels sending a test now. */
  testing: AlertChannel[];
}

const initialState: NotificationsPageState = { channels: null, failed: false, testing: [] };

/**
 * Settings → Notifications' data, provided by the page and gone with it: the email and ntfy
 * settings (secrets only as "saved"), saving them and sending a test, with their toasts.
 */
export const NotificationsPageStore = signalStore(
  withState<NotificationsPageState>(initialState),
  withMethods((store, alertsApi = inject(AlertsApi), translator = inject(Translator)) => {
    // After a save or a test too: the latest answer wins.
    const load = rxMethod<void>(
      pipe(
        switchMap(() =>
          alertsApi.channels().pipe(
            tap((channels) => patchState(store, { channels, failed: false })),
            catchError(() => {
              if (!store.channels()) patchState(store, { failed: true });
              return EMPTY;
            }),
          ),
        ),
      ),
    );
    return {
      load,

      /** Saves the mail settings; rejects with the server's error (the form puts it on its fields). */
      async saveEmail(update: EmailChannelUpdate): Promise<void> {
        await firstValueFrom(alertsApi.updateEmail(update));
        toast.success(translator.t('notifications.saved'));
        load();
      },

      /** Saves the ntfy settings; rejects with the server's error. */
      async saveNtfy(update: NtfyChannelUpdate): Promise<void> {
        await firstValueFrom(alertsApi.updateNtfy(update));
        toast.success(translator.t('notifications.saved'));
        load();
      },

      /** Sends a test message through a saved channel and says whether it got through. */
      async test(channel: AlertChannel): Promise<void> {
        patchState(store, { testing: [...store.testing(), channel] });
        try {
          const { sent, problem } = await firstValueFrom(alertsApi.test(channel));
          if (sent) toast.success(translator.t('notifications.testSent'));
          else {
            toast.error(translator.t('notifications.testFailed'), {
              description: translator.t(`alerts.problem.${problem ?? 'failed'}`),
            });
          }
        } catch (error) {
          toast.error(translator.t('notifications.testFailed'), {
            description: translator.t(...apiErrorText(error)),
          });
        } finally {
          patchState(store, { testing: store.testing().filter((c) => c !== channel) });
        }
        load();
      },
    };
  }),
  withHooks((store) => ({
    onInit() {
      store.load();
    },
  })),
);
