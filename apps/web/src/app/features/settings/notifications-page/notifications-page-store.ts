import { inject } from '@angular/core';
import { patchState, signalStore, withHooks, withMethods, withState } from '@ngrx/signals';
import type {
  AlertChannel,
  AlertChannelsResponse,
  EmailChannelUpdate,
  NtfyChannelUpdate,
} from '@laris/shared';
import { toast } from '@spartan-ng/brain/sonner';
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
  withMethods((store, api = inject(AlertsApi), translator = inject(Translator)) => ({
    async load(): Promise<void> {
      try {
        patchState(store, { channels: await api.channels(), failed: false });
      } catch {
        if (!store.channels()) patchState(store, { failed: true });
      }
    },

    /** Saves the mail settings; rejects with the server's error (the form puts it on its fields). */
    async saveEmail(update: EmailChannelUpdate): Promise<void> {
      await api.updateEmail(update);
      toast.success(translator.t('notifications.saved'));
      await this.load();
    },

    /** Saves the ntfy settings; rejects with the server's error. */
    async saveNtfy(update: NtfyChannelUpdate): Promise<void> {
      await api.updateNtfy(update);
      toast.success(translator.t('notifications.saved'));
      await this.load();
    },

    /** Sends a test message through a saved channel and says whether it got through. */
    async test(channel: AlertChannel): Promise<void> {
      patchState(store, { testing: [...store.testing(), channel] });
      try {
        const { sent, problem } = await api.test(channel);
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
      await this.load();
    },
  })),
  withHooks((store) => ({
    onInit() {
      void store.load();
    },
  })),
);
