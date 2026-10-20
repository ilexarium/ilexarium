import { inject } from '@angular/core';
import { signalStore, withMethods } from '@ngrx/signals';
import type { ChangePasswordRequest } from '@homelab/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { AuthApi } from '../../../core/auth/auth-api';
import { AuthStore } from '../../../core/auth/auth-store';
import { Translator } from '../../../core/i18n/translator';
import { apiErrorText } from '../../../shared/forms/submission-errors';

/**
 * The profile page's actions, provided by the page and gone with it: changing the password (the
 * page's password dialog), signing out everywhere. The profile itself is `AuthStore`'s user (from
 * `GET /api/auth/me`); editing it is the edit dialog's own store.
 */
export const ProfilePageStore = signalStore(
  withMethods(
    (_, auth = inject(AuthStore), api = inject(AuthApi), translator = inject(Translator)) => ({
      /** Changes the password and says so; rejects with the server's error (put on the fields). */
      async changePassword(request: ChangePasswordRequest): Promise<void> {
        await api.changePassword(request);
        toast.success(translator.t('account.changed'), {
          description: translator.t('account.changedText'),
        });
      },
      /** Ends every session, this one too; the app goes to the login page. */
      async signOutEverywhere(): Promise<void> {
        try {
          await auth.logoutEverywhere();
        } catch (error) {
          const [key, params] = apiErrorText(error);
          toast.error(translator.t('profile.signOutEverywhere.failed'), {
            description: translator.t(key, params),
          });
        }
      },
    }),
  ),
);
