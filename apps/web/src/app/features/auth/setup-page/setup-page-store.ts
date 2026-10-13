import { inject } from '@angular/core';
import { signalStore, withMethods } from '@ngrx/signals';
import type { SetupRequest } from '@homelab/shared';
import { AuthApi } from '../../../core/auth/auth-api';
import { AuthStore } from '../../../core/auth/auth-store';

/** The setup page's data, provided by the page and gone with it: creating the first account. */
export const SetupPageStore = signalStore(
  withMethods((_, api = inject(AuthApi), auth = inject(AuthStore)) => ({
    /** Creates the owner account and signs in; rejects with the server's error. */
    async setup(request: SetupRequest): Promise<void> {
      const { user } = await api.setup(request);
      auth.signedIn(user);
    },
  })),
);
