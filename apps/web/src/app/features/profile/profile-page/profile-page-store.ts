import { inject } from '@angular/core';
import { signalStore, withMethods } from '@ngrx/signals';
import type { ChangePasswordForm } from '@ilex/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import { exhaustMap, pipe, tap } from 'rxjs';
import { AuthApi } from '../../../core/auth/auth-api';
import { AuthStore } from '../../../core/auth/auth-store';
import { Translator } from '../../../core/i18n/translator';
import { withFormSubmission } from '../../../shared/forms/with-form-submission';

/**
 * The profile page's actions, provided by the page and gone with it: changing the password (the
 * page's password dialog), signing out everywhere. The profile itself is `AuthStore`'s user (from
 * `GET /api/auth/me`); editing it is the edit dialog's own store.
 */
export const ProfilePageStore = signalStore(
  withFormSubmission<ChangePasswordForm>(),
  withMethods(
    (
      store,
      authStore = inject(AuthStore),
      authApi = inject(AuthApi),
      translator = inject(Translator),
    ) => ({
      /** Changes the password and says so; a refusal becomes the form's server errors. */
      changePassword: rxMethod<ChangePasswordForm>(
        pipe(
          exhaustMap((form) =>
            store
              ._submit(
                form,
                authApi.changePassword({
                  currentPassword: form.currentPassword,
                  newPassword: form.newPassword,
                }),
              )
              .pipe(
                tap(() =>
                  toast.success(translator.t('account.changed'), {
                    description: translator.t('account.changedText'),
                  }),
                ),
              ),
          ),
        ),
      ),
      /** Ends every session, this one too; the app goes to the login page. */
      signOutEverywhere: rxMethod<void>(tap(() => authStore.logoutEverywhere())),
    }),
  ),
);
