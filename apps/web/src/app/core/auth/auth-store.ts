import { computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import { patchState, signalStore, withComputed, withMethods, withState } from '@ngrx/signals';
import type { PublicUser } from '@homelab/shared';
import { AuthApi } from './auth-api';
import type { AuthStatus } from './auth.model';

interface AuthState {
  user: PublicUser | null;
  status: AuthStatus;
  needsSetup: boolean;
}

/**
 * Who is signed in, app-wide. The session itself is an HttpOnly cookie the browser handles —
 * no token ever lives in JavaScript.
 *
 * Rule for every global store added later: reset it on sign-out, so nothing of the previous
 * user remains in memory.
 */
export const AuthStore = signalStore(
  { providedIn: 'root' },
  withState<AuthState>({ user: null, status: 'unknown', needsSetup: false }),
  withComputed(({ status }) => ({
    isAuthenticated: computed(() => status() === 'authenticated'),
  })),
  withMethods((store, api = inject(AuthApi), router = inject(Router)) => {
    const sessionEnded = () => patchState(store, { user: null, status: 'anonymous' });
    return {
      /** Asks the server whether setup is needed and who is signed in. Never throws. */
      async load(): Promise<void> {
        patchState(store, { status: 'unknown' });
        try {
          const [{ needsSetup }, { user }] = await Promise.all([api.status(), api.me()]);
          patchState(store, { needsSetup, user, status: user ? 'authenticated' : 'anonymous' });
        } catch {
          patchState(store, { user: null, status: 'unreachable' });
        }
      },
      /** After a successful login or setup. */
      signedIn(user: PublicUser): void {
        patchState(store, { user, status: 'authenticated', needsSetup: false });
      },
      /** The server says the session is missing or ended (a 401). */
      sessionEnded,
      /**
       * The session ended while the app was in use (an API 401, a WebSocket 4401): clear it and go
       * to the login page, remembering where the user was. "Expired" only if they were signed in.
       */
      sessionExpired(): void {
        const wasSignedIn = store.status() === 'authenticated';
        sessionEnded();
        if (!router.url.startsWith('/login')) {
          void router.navigate(['/login'], {
            queryParams: {
              ...(router.url !== '/' && { returnUrl: router.url }),
              ...(wasSignedIn && { reason: 'expired' }),
            },
          });
        }
      },
      async logout(): Promise<void> {
        try {
          await api.logout();
        } finally {
          sessionEnded();
          await router.navigateByUrl('/login');
        }
      },
    };
  }),
);
