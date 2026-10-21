import { inject } from '@angular/core';
import { signalStore, withMethods } from '@ngrx/signals';
import type { LoginRequest } from '@homelab/shared';
import { AuthApi } from '../../../core/auth/auth-api';
import { AuthStore } from '../../../core/auth/auth-store';

export const LoginPageStore = signalStore(
  withMethods((_, api = inject(AuthApi), auth = inject(AuthStore)) => ({
    /** Rejects with the server's error, for the form's fields. */
    async login(request: LoginRequest): Promise<void> {
      const { user } = await api.login(request);
      auth.signedIn(user);
    },
  })),
);
