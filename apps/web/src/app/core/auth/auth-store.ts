import { computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import {
  patchState,
  signalStore,
  withComputed,
  withHooks,
  withMethods,
  withState,
} from '@ngrx/signals';
import type { PublicUser } from '@homelab/shared';
import { LanguageService } from '../i18n/language';
import { AuthApi } from './auth-api';
import type { AuthStatus } from './auth.model';
import { SIGN_OUT_CHANNEL } from './sign-out-channel';

interface AuthState {
  user: PublicUser | null;
  status: AuthStatus;
  needsSetup: boolean;
}

/**
 * The session itself is an HttpOnly cookie: no token ever lives in JavaScript. Loaded at startup,
 * so it imports nothing of `@homelab/shared` but types (a small first download).
 *
 * Every global store resets on sign-out (following `isAuthenticated`), so nothing of the previous
 * user stays in memory.
 */
export const AuthStore = signalStore(
  { providedIn: 'root' },
  withState<AuthState>({ user: null, status: 'unknown', needsSetup: false }),
  withComputed(({ status }) => ({
    isAuthenticated: computed(() => status() === 'authenticated'),
  })),
  withMethods(
    (
      store,
      api = inject(AuthApi),
      languages = inject(LanguageService),
      router = inject(Router),
      channel = inject(SIGN_OUT_CHANNEL),
    ) => {
      const sessionEnded = () => patchState(store, { user: null, status: 'anonymous' });
      /** Signing out on purpose: the socket closing with 4401 meanwhile isn't an expiry. */
      let leaving = false;
      const applyLanguage = async (user: PublicUser | null) => {
        if (!user?.language || user.language === languages.language()) return;
        await languages.setLanguage(user.language).catch(() => undefined);
      };
      const toLogin = (expired: boolean) => {
        if (router.url.startsWith('/login')) return;
        void router.navigate(['/login'], {
          queryParams: {
            ...(router.url !== '/' && { returnUrl: router.url }),
            ...(expired && { reason: 'expired' }),
          },
        });
      };
      const signedOut = async () => {
        sessionEnded();
        await router.navigateByUrl('/login');
      };
      // Before the server call: the other tabs' sockets close with 4401 while it runs, and they
      // should take it for a sign-out, not an expiry. A failed call signs this tab out too.
      const tellOtherTabs = () => channel?.postMessage(null);
      return {
        /** Never throws: an unreachable server is never taken for signed out. */
        async load(): Promise<void> {
          patchState(store, { status: 'unknown' });
          try {
            const [{ needsSetup }, { user }] = await Promise.all([api.status(), api.me()]);
            patchState(store, { needsSetup, user, status: user ? 'authenticated' : 'anonymous' });
            await applyLanguage(user);
          } catch {
            patchState(store, { user: null, status: 'unreachable' });
          }
        },
        signedIn(user: PublicUser): void {
          patchState(store, { user, status: 'authenticated', needsSetup: false });
          void applyLanguage(user);
        },
        /** The user as a profile change returned it. */
        updated(user: PublicUser): void {
          if (store.isAuthenticated()) patchState(store, { user });
        },
        sessionEnded,
        /** An API 401 or a WebSocket 4401 while in use. "Expired" only if they were signed in. */
        sessionExpired(): void {
          if (leaving) return;
          const wasSignedIn = store.status() === 'authenticated';
          sessionEnded();
          toLogin(wasSignedIn);
        },
        /** Another tab signed out: this one shares its cookie. */
        signedOutElsewhere(): void {
          if (!store.isAuthenticated()) return;
          sessionEnded();
          toLogin(false);
        },
        async logout(): Promise<void> {
          tellOtherTabs();
          try {
            await api.logout();
          } finally {
            await signedOut();
          }
        },
        async logoutEverywhere(): Promise<void> {
          leaving = true;
          tellOtherTabs();
          try {
            await api.logoutEverywhere();
            await signedOut();
          } finally {
            leaving = false;
          }
        },
      };
    },
  ),
  withHooks((store, channel = inject(SIGN_OUT_CHANNEL)) => ({
    onInit() {
      channel?.addEventListener('message', () => store.signedOutElsewhere());
    },
    onDestroy() {
      channel?.close();
    },
  })),
);
