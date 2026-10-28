import { HttpErrorResponse } from '@angular/common/http';
import { computed, effect, inject } from '@angular/core';
import {
  patchState,
  signalStore,
  withComputed,
  withHooks,
  withMethods,
  withState,
} from '@ngrx/signals';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import {
  FILES_ERROR_CODES,
  FILES_LIMITS,
  type LinuxSession,
  type LinuxSignInRequest,
} from '@laris/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { catchError, EMPTY, exhaustMap, firstValueFrom, pipe, tap } from 'rxjs';
import { apiErrorCode, apiErrorText } from '../../shared/forms/submission-errors';
import { AuthStore } from '../auth/auth-store';
import { FilesApi } from '../files/files-api';
import { Translator } from '../i18n/translator';
import { SUDO_CLOCK_MS } from './linux-session-store.constants';

interface LinuxSessionState {
  /** Asked the server whether a Linux session is open. */
  checked: boolean;
  session: LinuxSession | null;
  /** The sudo password is asked (an action waits for it). */
  sudoPrompt: boolean;
  /** Which prompt: a late "closed" of an earlier one never cancels a newer one. */
  sudoPromptId: number;
  /** For the minutes of sudo left. */
  now: number;
}

const initialState: LinuxSessionState = {
  checked: false,
  session: null,
  sudoPrompt: false,
  sudoPromptId: 0,
  now: Date.now(),
};

/**
 * The Linux session of this browser session (docs/plans/acting_as_you.md), shared by Files, the
 * terminal, Processes and the top bar: the account, and whether its sudo is unlocked — an
 * estimate the server keeps; sudo's own `sudo_required` is the truth. Actions that need sudo run
 * through `withSudo`, which asks for the password (the shell's prompt) and carries on. The
 * password goes to the server once, for sudo, and isn't kept here. Reset on sign-out.
 */
export const LinuxSessionStore = signalStore(
  { providedIn: 'root' },
  withState<LinuxSessionState>(initialState),
  withComputed((store) => ({
    /** Whole minutes of sudo left (rounded up); null while locked. */
    sudoMinutes: computed(() => {
      const until = store.session()?.sudoUntil;
      const left = until ? Date.parse(until) - store.now() : 0;
      return left > 0 ? Math.ceil(left / 60_000) : null;
    }),
  })),
  withMethods((store, filesApi = inject(FilesApi), translator = inject(Translator)) => {
    /** The prompt's answer: unlocked, or not (cancelled). */
    let prompted: { promise: Promise<boolean>; resolve: (unlocked: boolean) => void } | null = null;
    const answerPrompt = (unlocked: boolean) => {
      prompted?.resolve(unlocked);
      prompted = null;
      patchState(store, { sudoPrompt: false });
    };
    /** An action found the Linux session gone (idle, closed elsewhere). */
    const ended = () => {
      patchState(store, { session: null });
      answerPrompt(false);
    };
    const failed = (error: unknown) => {
      if (apiErrorCode(error) === FILES_ERROR_CODES.linuxSessionRequired) ended();
      toast.error(translator.t('files.actionFailed'), {
        description: translator.t(...apiErrorText(error)),
      });
    };
    const setSudoUntil = (until: number | null) => {
      const session = store.session();
      if (!session) return;
      const sudoUntil = until === null ? null : new Date(until).toISOString();
      patchState(store, { session: { ...session, sudoUntil }, now: Date.now() });
    };
    /** Asks for the sudo password; true once unlocked, false when cancelled. */
    const requestSudo = (): Promise<boolean> => {
      if (!prompted) {
        let resolve!: (unlocked: boolean) => void;
        const promise = new Promise<boolean>((done) => (resolve = done));
        prompted = { promise, resolve };
        patchState(store, { sudoPrompt: true, sudoPromptId: store.sudoPromptId() + 1 });
      }
      return prompted.promise;
    };

    return {
      check: rxMethod<void>(
        pipe(
          exhaustMap(() =>
            filesApi.session().pipe(
              tap(({ session }) => patchState(store, { session, checked: true })),
              catchError((error: unknown) => {
                patchState(store, { checked: true });
                // A 401: the app session is gone, and the app signs out on its own.
                if (!(error instanceof HttpErrorResponse && error.status === 401)) failed(error);
                return EMPTY;
              }),
            ),
          ),
        ),
      ),

      /** Signs in as a Linux user; rejects with the server's error (the form shows it). */
      async signIn(request: LinuxSignInRequest): Promise<void> {
        const session = await firstValueFrom(filesApi.signIn(request));
        patchState(store, { session, checked: true });
      },

      async signOut(): Promise<void> {
        try {
          await firstValueFrom(filesApi.signOut());
          patchState(store, { session: null });
          toast.success(translator.t('files.closed'));
        } catch (error) {
          failed(error);
        }
      },

      ended,

      /** The prompt's password; rejects with the server's error (the form shows it). */
      async unlockSudo(password: string): Promise<void> {
        try {
          const session = await firstValueFrom(filesApi.unlockSudo({ password }));
          patchState(store, { session, now: Date.now() });
        } catch (error) {
          if (apiErrorCode(error) === FILES_ERROR_CODES.linuxSessionRequired) ended();
          throw error;
        }
        answerPrompt(true);
      },

      /** Cancelled; with `id`, only while that prompt is still the one asked. */
      cancelSudo(id?: number): void {
        if (id !== undefined && (id !== store.sudoPromptId() || !store.sudoPrompt())) return;
        answerPrompt(false);
      },

      /** "Lock now": sudo locked, and the Linux session ends. */
      async lockNow(): Promise<void> {
        try {
          await firstValueFrom(filesApi.lockSudo());
          patchState(store, { session: null });
          toast.success(translator.t('linux.locked'));
        } catch (error) {
          failed(error);
        }
      },

      /**
       * Runs an action that needs sudo: the password asked first while locked, and again when
       * sudo says it ran out meanwhile (then the action once more). Null when the prompt was
       * cancelled; the action's own errors are passed on.
       */
      async withSudo<T>(action: () => Promise<T>): Promise<T | null> {
        if (store.sudoMinutes() === null && !(await requestSudo())) return null;
        let result: T;
        try {
          result = await action();
        } catch (error) {
          if (apiErrorCode(error) !== FILES_ERROR_CODES.sudoRequired) throw error;
          setSudoUntil(null);
          if (!(await requestSudo())) return null;
          result = await action();
        }
        // Each use restarts sudo's time (the server's estimate does the same).
        setSudoUntil(Date.now() + FILES_LIMITS.sudoEstimateMinutes * 60_000);
        return result;
      },

      tick(): void {
        patchState(store, { now: Date.now() });
      },

      reset(): void {
        answerPrompt(false);
        patchState(store, { ...initialState, now: Date.now() });
      },
    };
  }),
  withHooks((store, authStore = inject(AuthStore)) => {
    let clock: ReturnType<typeof setInterval> | undefined;
    return {
      onInit() {
        effect(() => {
          if (!authStore.isAuthenticated()) store.reset();
        });
        clock = setInterval(() => {
          if (store.session()?.sudoUntil) store.tick();
        }, SUDO_CLOCK_MS);
      },
      onDestroy() {
        clearInterval(clock);
      },
    };
  }),
);
