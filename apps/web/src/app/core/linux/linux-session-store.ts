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
  finalize,
  firstValueFrom,
  map,
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
 * through `withSudo$`, which asks for the password (the shell's prompt) and carries on. The
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
    const sudoQuestion = new SharedPrompt<true>({
      showDialog: () =>
        patchState(store, { sudoPrompt: true, sudoPromptId: store.sudoPromptId() + 1 }),
      hideDialog: () => patchState(store, { sudoPrompt: false }),
    });
    // The sign-in's answer carries its password to the actions waiting for it, so one of them that
    // turns out to need sudo unlocks it without asking again (null: already signed in).
    const signInQuestion = new SharedPrompt<{ password: string | null }>({
      showDialog: () => patchState(store, { signInPrompt: true }),
      hideDialog: () => patchState(store, { signInPrompt: false }),
    });
    // Only from the prompt's sign-in until its dialog closes, a moment later; never state.
    let promptPassword: string | null = null;
    const answerPrompt = (unlocked: boolean) => sudoQuestion.answerWith(unlocked ? true : null);
    const answerSignIn = (signedIn: boolean) => {
      const password = promptPassword;
      promptPassword = null;
      signInQuestion.answerWith(signedIn ? { password } : null);
    };
    const notNull = <T>(value: T | null): value is T => value !== null;
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
    // Each use starts ilex-root's idle time again (the server counts the same).
    const restartSudoMinutes = () =>
      setSudoUntil(Date.now() + FILES_LIMITS.sudoIdleMinutes * 60_000);
    // sudo may have been used: the top bar's minutes come from the server's estimate.
    /** Unlocks sudo with the password the sign-in prompt just took; fails with the server's error. */
    const unlockWith$ = (password: string): Observable<true> =>
      filesApi.unlockSudo({ password }).pipe(
        map((session) => {
          patchState(store, { session, now: Date.now() });
          // Another action waiting at the sudo prompt carries on too.
          if (store.sudoPrompt()) answerPrompt(true);
          return true as const;
        }),
        catchError((error: unknown) => {
          if (apiErrorCode(error) === FILES_ERROR_CODES.linuxSessionRequired) ended();
          return throwError(() => error);
        }),
      );
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

      /** The session as the server sees it now (sudo may have ended there); fails on failure. */
      refresh$(): Observable<void> {
        return filesApi.session().pipe(
          map(({ session }) => {
            patchState(store, { session, checked: true, now: Date.now() });
          }),
        );
      },

      /** Signs in as a Linux user; rejects with the server's error (the form shows it). */
      async signIn(request: LinuxSignInRequest): Promise<void> {
        const session = await firstValueFrom(filesApi.signIn(request));
        if (store.signInPrompt()) promptPassword = request.password;
        patchState(store, { session, checked: true });
      },

      signOut: rxMethod<void>(
        pipe(
          exhaustMap(() =>
            filesApi.signOut().pipe(
              tap(() => {
                patchState(store, { session: null });
                toast.success(translator.t('files.closed'));
              }),
              catchError((error: unknown) => {
                failed(error);
                return EMPTY;
              }),
            ),
          ),
        ),
      ),

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
      lockNow: rxMethod<void>(
        pipe(
          exhaustMap(() =>
            filesApi.lockSudo().pipe(
              tap(({ session }) => {
                patchState(store, { session, now: Date.now() });
                toast.success(translator.t('linux.locked'));
              }),
              catchError((error: unknown) => {
                failed(error);
                return EMPTY;
              }),
            ),
          ),
        ),
      ),

      /**
       * Runs an action that needs sudo: the password asked first while locked (nothing before
       * subscribing), and again when sudo ran out meanwhile, then the action once more. Null when
       * the prompt was closed; the action's own errors are passed on. Only an answer closes the
       * prompt.
       */
      withSudo$<T>(action: () => Observable<T>): Observable<T | null> {
        const askToRetry = (error: unknown): Observable<boolean> => {
          if (apiErrorCode(error) !== FILES_ERROR_CODES.sudoRequired)
            return throwError(() => error);
          setSudoUntil(null);
          return sudoQuestion.ask().pipe(filter(notNull));
        };
        return sudoQuestion
          .ask({ skipWith: () => (store.sudoMinutes() !== null ? true : undefined) })
          .pipe(
            filter(notNull),
            switchMap(() =>
              defer(action).pipe(tap(restartSudoMinutes), retry({ count: 1, delay: askToRetry })),
            ),
            defaultIfEmpty(null),
          );
      },

      /**
       * Runs a change done as the person (an app, a backup, a disk): the Linux sign-in first
       * without a session (nothing before subscribing); the sudo password or the sign-in again
       * when the server asks for it, then the action once more (three tries at most). Null when a
       * prompt was closed — it emits once and completes (a form reads it with `firstValueFrom`);
       * the action's own errors are passed on. Only an answer closes a prompt. Signed in here and
       * then needing sudo, the sign-in's password unlocks it once, without a second prompt (its
       * failure is the action's error).
       */
      asPerson$<T>(action: () => Observable<T>): Observable<T | null> {
        return defer(() => {
          // This call's own: from its sign-in prompt to its one use, or the call's end.
          let password: string | null = null;
          const signedIn = (answer: { password: string | null }) => {
            password = answer.password;
          };
          const askToRetry = (error: unknown): Observable<unknown> => {
            const code = apiErrorCode(error);
            if (code === FILES_ERROR_CODES.sudoRequired) {
              setSudoUntil(null);
              const typed = password;
              password = null;
              return typed !== null ? unlockWith$(typed) : sudoQuestion.ask().pipe(filter(notNull));
            }
            if (code === FILES_ERROR_CODES.linuxSessionRequired) {
              ended();
              return signInQuestion.ask().pipe(filter(notNull), tap(signedIn));
            }
            return throwError(() => error);
          };
          return signInQuestion
            .ask({ skipWith: () => (store.session() !== null ? { password: null } : undefined) })
            .pipe(
              filter(notNull),
              tap(signedIn),
              switchMap(() =>
                defer(action).pipe(tap(refreshSession), retry({ count: 2, delay: askToRetry })),
              ),
              defaultIfEmpty(null),
              finalize(() => (password = null)),
            );
        });
      },

      /** The shell's sign-in prompt closed: signed in now, or not. */
      signInClosed(): void {
        answerSignIn(store.session() !== null);
      },

      tick(): void {
        patchState(store, { now: Date.now() });
      },

      reset(): void {
        answerPrompt(false);
        answerSignIn(false);
        promptPassword = null;
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
