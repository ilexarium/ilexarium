import { inject } from '@angular/core';
import { signalStore, withMethods } from '@ngrx/signals';
import type { SetupRequest } from '@laris/shared';
import { firstValueFrom } from 'rxjs';
import { AuthApi } from '../../../core/auth/auth-api';
import { AuthStore } from '../../../core/auth/auth-store';

export const SetupPageStore = signalStore(
  withMethods((_, api = inject(AuthApi), auth = inject(AuthStore)) => ({
    /** Rejects with the server's error, for the form's fields. */
    async setup(request: SetupRequest): Promise<void> {
      const { user } = await firstValueFrom(api.setup(request));
      auth.signedIn(user);
    },
  })),
);
