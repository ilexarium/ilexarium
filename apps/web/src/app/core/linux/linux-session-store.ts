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
} from '@ilex/shared';
import { toast } from '@spartan-ng/brain/sonner';
import {
  catchError,
  defaultIfEmpty,
  defer,
  EMPTY,
  exhaustMap,
  filter,
  firstValueFrom,
  type Observable,
  pipe,
  retry,
  switchMap,
  tap,
  throwError,
} from 'rxjs';
import { apiErrorCode, apiErrorText } from '../../shared/forms/submission-errors';
import { AuthStore } from '../auth/auth-store';
import { FilesApi } from '../files/files-api';
import { Translator } from '../i18n/translator';
import { SUDO_CLOCK_MS } from './linux-session-store.constants';
import { SharedPrompt } from './shared-prompt';

interface LinuxSessionState {
  /** Asked the server whether a Linux session is open. */
  checked: boolean;
  session: LinuxSession | null;
  /** The sudo password is asked (an action waits for it). */
  sudoPrompt: boolean;
  /** Which prompt: a late "closed" of an earlier one never cancels a newer one. */
  sudoPromptId: number;
  /** The Linux sign-in is asked (an action waits for a Linux session). */
  signInPrompt: boolean;
  /** For the minutes of sudo left. */
  now: number;
}

const initialState: LinuxSessionState = {
  checked: false,
  session: null,
  sudoPrompt: false,
  sudoPromptId: 0,
  signInPrompt: false,
  now: Date.now(),
};

/**
 * The Linux session of this browser session, shared by Files, the
 * terminal, Processes and the top bar: the account, and whether its sudo is unlocked (ilex-root
 * runs, until its idle limit; the server's `sudo_required` is the truth when it ended sooner). Actions that need sudo run
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
    const sudoQuestion = new SharedPrompt({
      showDialog: () =>
        patchState(store, { sudoPrompt: true, sudoPromptId: store.sudoPromptId() + 1 }),
      hideDialog: () => patchState(store, { sudoPrompt: false }),
    });
    const signInQuestion = new SharedPrompt({
      showDialog: () => patchState(store, { signInPrompt: true }),
      hideDialog: () => patchState(store, { signInPrompt: false }),
    });
    const answerPrompt = (unlocked: boolean) => sudoQuestion.answerWith(unlocked);
    const answerSignIn = (signedIn: boolean) => signInQuestion.answerWith(signedIn);
    /** Asks for the Linux sign-in; true once signed in, false when closed. */
    const requestSignIn = (): Promise<boolean> => firstValueFrom(signInQuestion.ask());
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
    const requestSudo = (): Promise<boolean> => firstValueFrom(sudoQuestion.ask());
    // Each use starts ilex-root's idle time again (the server counts the same).
    const restartSudoMinutes = () =>
      setSudoUntil(Date.now() + FILES_LIMITS.sudoIdleMinutes * 60_000);
    // sudo may have been used: the top bar's minutes come from the server's estimate.
    const refreshSession = () =>
      filesApi.session().subscribe({
        next: ({ session }) => patchState(store, { session, now: Date.now() }),
        error: () => undefined,
      });

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

      /** The session as the server sees it now (sudo may have ended there); rejects on failure. */
      async refresh(): Promise<void> {
        const { session } = await firstValueFrom(filesApi.session());
        patchState(store, { session, checked: true, now: Date.now() });
      },

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

      /** "Lock now": sudo locked; the Linux session stays. */
      async lockNow(): Promise<void> {
        try {
          const { session } = await firstValueFrom(filesApi.lockSudo());
          patchState(store, { session, now: Date.now() });
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
        restartSudoMinutes();
        return result;
      },

      /**
       * Runs a change done as the person (an app, a backup, a disk): the Linux sign-in first
       * without a session; the sudo password only when the server says sudo is needed and
       * locked; then the action once more. Null when a prompt was closed; the action's own
       * errors are passed on.
       */
      async asPerson<T>(action: () => Promise<T>): Promise<T | null> {
        if (!store.session() && !(await requestSignIn())) return null;
        for (let attempt = 0; ; attempt++) {
          try {
            const result = await action();
            refreshSession();
            return result;
          } catch (error) {
            const code = apiErrorCode(error);
            if (attempt >= 2) throw error;
            if (code === FILES_ERROR_CODES.sudoRequired) {
              setSudoUntil(null);
              if (!(await requestSudo())) return null;
            } else if (code === FILES_ERROR_CODES.linuxSessionRequired) {
              ended();
              if (!(await requestSignIn())) return null;
            } else {
              throw error;
            }
          }
        }
      },

      /**
       * `withSudo` as an Observable: the password asked first while locked (nothing before
       * subscribing), and again when sudo ran out meanwhile, then the action once more. Null when
       * the prompt was closed; unsubscribing while it's asked closes it.
       */
      withSudo$<T>(action: () => Observable<T>): Observable<T | null> {
        const askToRetry = (error: unknown): Observable<boolean> => {
          if (apiErrorCode(error) !== FILES_ERROR_CODES.sudoRequired)
            return throwError(() => error);
          setSudoUntil(null);
          return sudoQuestion.ask().pipe(filter(Boolean));
        };
        return sudoQuestion.ask({ skipWhen: () => store.sudoMinutes() !== null }).pipe(
          filter(Boolean),
          switchMap(() =>
            defer(action).pipe(tap(restartSudoMinutes), retry({ count: 1, delay: askToRetry })),
          ),
          defaultIfEmpty(null),
        );
      },

      /**
       * `asPerson` as an Observable: the Linux sign-in first without a session (nothing before
       * subscribing); the sudo password or the sign-in again when the server asks for it, then the
       * action once more (three tries at most). Null when a prompt was closed — it emits once and
       * completes; unsubscribing while a prompt is asked closes it.
       */
      asPerson$<T>(action: () => Observable<T>): Observable<T | null> {
        const askToRetry = (error: unknown): Observable<boolean> => {
          const code = apiErrorCode(error);
          if (code === FILES_ERROR_CODES.sudoRequired) {
            setSudoUntil(null);
            return sudoQuestion.ask().pipe(filter(Boolean));
          }
          if (code === FILES_ERROR_CODES.linuxSessionRequired) {
            ended();
            return signInQuestion.ask().pipe(filter(Boolean));
          }
          return throwError(() => error);
        };
        return signInQuestion.ask({ skipWhen: () => store.session() !== null }).pipe(
          filter(Boolean),
          switchMap(() =>
            defer(action).pipe(tap(refreshSession), retry({ count: 2, delay: askToRetry })),
          ),
          defaultIfEmpty(null),
        );
      },

      /** The shell's sign-in prompt: signed in (true) or closed. */
      signInAnswered(signedIn: boolean): void {
        answerSignIn(signedIn && store.session() !== null);
      },

      tick(): void {
        patchState(store, { now: Date.now() });
      },

      reset(): void {
        answerPrompt(false);
        answerSignIn(false);
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
