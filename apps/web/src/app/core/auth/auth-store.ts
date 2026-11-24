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
import type { PublicUser } from '@ilex/shared';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import { toast } from '@spartan-ng/brain/sonner';
import { catchError, EMPTY, exhaustMap, finalize, firstValueFrom, forkJoin, pipe, tap } from 'rxjs';
import { LanguageService } from '../i18n/language';
import { Translator } from '../i18n/translator';
import { AuthApi } from './auth-api';
import type { AuthStatus } from './auth.model';
import { SIGN_OUT_CHANNEL } from './sign-out-channel';

interface AuthState {
  user: PublicUser | null;
  status: AuthStatus;
  needsSetup: boolean;
  /** Signing out everywhere: the socket closing with 4401 meanwhile isn't an expiry. */
  _leaving: boolean;
}

/**
 * The session itself is an HttpOnly cookie: no token ever lives in JavaScript. Loaded at startup,
 * so it imports nothing of `@ilex/shared` but types (a small first download).
 *
 * Every global store resets on sign-out (following `isAuthenticated`), so nothing of the previous
 * user stays in memory.
 */
export const AuthStore = signalStore(
  { providedIn: 'root' },
  withState<AuthState>({ user: null, status: 'unknown', needsSetup: false, _leaving: false }),
  withComputed(({ status }) => ({
    isAuthenticated: computed(() => status() === 'authenticated'),
  })),
  withMethods(
    (
      store,
      api = inject(AuthApi),
      languageService = inject(LanguageService),
      router = inject(Router),
      channel = inject(SIGN_OUT_CHANNEL),
      translator = inject(Translator),
    ) => {
      const sessionEnded = () => patchState(store, { user: null, status: 'anonymous' });
      const applyLanguage = async (user: PublicUser | null) => {
        if (!user?.language || user.language === languageService.language()) return;
        await firstValueFrom(languageService.setLanguage(user.language)).catch(() => undefined);
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
      const signedOut = () => {
        sessionEnded();
        void router.navigateByUrl('/login');
      };
      // Before the server call: the other tabs' sockets close with 4401 while it runs, and they
      // should take it for a sign-out, not an expiry. A failed call signs this tab out too.
      const tellOtherTabs = () => channel?.postMessage(null);
      return {
        /** Never throws: an unreachable server is never taken for signed out. */
        async load(): Promise<void> {
          patchState(store, { status: 'unknown' });
          try {
            const [{ needsSetup }, { user }] = await firstValueFrom(
              forkJoin([api.status(), api.me()]),
            );
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
          if (store._leaving()) return;
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
        /** Signed out here even when the server can't be reached. */
        logout: rxMethod<void>(
          pipe(
            exhaustMap(() => {
              tellOtherTabs();
              return api.logout().pipe(
                catchError(() => EMPTY),
                finalize(() => signedOut()),
              );
            }),
          ),
        ),
        /**
         * Ends every session, this one too. Here, not in the page that asks: leaving the page must
         * not cancel it once the other tabs were told.
         */
        logoutEverywhere: rxMethod<void>(
          pipe(
            exhaustMap(() => {
              patchState(store, { _leaving: true });
              tellOtherTabs();
              return api.logoutEverywhere().pipe(
                tap(() => signedOut()),
                catchError((error: unknown) => {
                  // The wording of errors isn't part of the startup download: loaded when needed.
                  void import('../../shared/forms/submission-errors').then(({ apiErrorText }) =>
                    toast.error(translator.t('profile.signOutEverywhere.failed'), {
                      description: translator.t(...apiErrorText(error)),
                    }),
                  );
                  return EMPTY;
                }),
                finalize(() => patchState(store, { _leaving: false })),
              );
            }),
          ),
        ),
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
