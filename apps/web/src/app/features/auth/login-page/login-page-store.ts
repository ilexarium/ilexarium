import { inject } from '@angular/core';
import { signalStore, withMethods } from '@ngrx/signals';
import type { LoginRequest } from '@homelab/shared';
import { AuthApi } from '../../../core/auth/auth-api';
import { AuthStore } from '../../../core/auth/auth-store';

/** The login page's data, provided by the page and gone with it: signing in. */
export const LoginPageStore = signalStore(
  withMethods((_, api = inject(AuthApi), auth = inject(AuthStore)) => ({
    /** Signs in; rejects with the server's error (the form puts it on its fields). */
    async login(request: LoginRequest): Promise<void> {
      const { user } = await api.login(request);
      auth.signedIn(user);
    },
  })),
);
