import { inject } from '@angular/core';
import { signalStore, withMethods } from '@ngrx/signals';
import type { ChangePasswordRequest } from '@homelab/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { AuthApi } from '../../../core/auth/auth-api';
import { Translator } from '../../../core/i18n/translator';

/** The account page's data, provided by the page and gone with it: changing the password. */
export const AccountPageStore = signalStore(
  withMethods((_, api = inject(AuthApi), translator = inject(Translator)) => ({
    /** Changes the password and says so; rejects with the server's error (put on the fields). */
    async changePassword(request: ChangePasswordRequest): Promise<void> {
      await api.changePassword(request);
      toast.success(translator.t('account.changed'), {
        description: translator.t('account.changedText'),
      });
    },
  })),
);
