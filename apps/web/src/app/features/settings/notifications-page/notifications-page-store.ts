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
import { catchError, EMPTY, finalize, firstValueFrom, mergeMap, pipe, switchMap, tap } from 'rxjs';
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
      test: rxMethod<AlertChannel>(
        pipe(
          // Channels side by side; a repeat for one while it runs is ignored.
          mergeMap((channel) => {
            if (store.testing().includes(channel)) return EMPTY;
            return alertsApi.test(channel).pipe(
              tap({
                subscribe: () => patchState(store, { testing: [...store.testing(), channel] }),
                next: ({ sent, problem }) => {
                  if (sent) toast.success(translator.t('notifications.testSent'));
                  else {
                    toast.error(translator.t('notifications.testFailed'), {
                      description: translator.t(`alerts.problem.${problem ?? 'failed'}`),
                    });
                  }
                },
              }),
              catchError((error: unknown) => {
                toast.error(translator.t('notifications.testFailed'), {
                  description: translator.t(...apiErrorText(error)),
                });
                return EMPTY;
              }),
              finalize(() => {
                patchState(store, { testing: store.testing().filter((c) => c !== channel) });
                load();
              }),
            );
          }),
        ),
      ),
    };
  }),
  withHooks((store) => ({
    onInit() {
      store.load();
    },
  })),
);
