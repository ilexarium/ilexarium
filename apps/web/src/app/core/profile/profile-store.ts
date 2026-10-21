import { inject } from '@angular/core';
import { signalStore, withMethods } from '@ngrx/signals';
import type { UserLanguage } from '@laris/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { apiErrorText } from '../../shared/forms/submission-errors';
import { AuthStore } from '../auth/auth-store';
import { LanguageService } from '../i18n/language';
import { Translator } from '../i18n/translator';
import { ProfileApi } from './profile-api';

/**
 * Profile changes made outside the edit dialog: the language, from the user menu and the profile
 * page. No state of its own — the profile is `AuthStore`'s user — so nothing to reset at sign-out.
 * Apart from `AuthStore` so the startup code doesn't load the API's contract.
 */
export const ProfileStore = signalStore(
  { providedIn: 'root' },
  withMethods(
    (
      _,
      auth = inject(AuthStore),
      api = inject(ProfileApi),
      languages = inject(LanguageService),
      translator = inject(Translator),
    ) => ({
      /** Shows the app in `language`, and keeps it for the account (it follows to other browsers). */
      async chooseLanguage(language: UserLanguage): Promise<void> {
        try {
          await languages.setLanguage(language);
        } catch (error) {
          // Its file didn't load (offline, an update under way): the language stays as it was.
          const [key, params] = apiErrorText(error);
          toast.error(translator.t('profile.languageNotLoaded'), {
            description: translator.t(key, params),
          });
          return;
        }
        if (!auth.isAuthenticated() || auth.user()?.language === language) return;
        try {
          auth.updated((await api.update({ language })).user);
        } catch (error) {
          // Shown here all the same; only other browsers won't know.
          const [key, params] = apiErrorText(error);
          toast.error(translator.t('profile.languageNotSaved'), {
            description: translator.t(key, params),
          });
        }
      },
    }),
  ),
);
