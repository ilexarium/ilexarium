import { computed, inject } from '@angular/core';
import {
  patchState,
  signalStore,
  withComputed,
  withHooks,
  withMethods,
  withState,
} from '@ngrx/signals';
import type { PersonCheck } from '@ilex/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import {
  catchError,
  concatMap,
  defer,
  EMPTY,
  exhaustMap,
  finalize,
  type Observable,
  of,
  pipe,
  tap,
} from 'rxjs';
import { Translator } from '../../../core/i18n/translator';
import { LinuxSessionStore } from '../../../core/linux/linux-session-store';
import { MachineCheckApi } from '../../../core/machine-check/machine-check-api';
import { apiErrorText } from '../../../shared/forms/submission-errors';
import { COMMANDS, STEPS } from './machine-check-page.constants';
import type { MachineCheckStep, MachineCheckStepId } from './machine-check-page.model';

interface MachineCheckPageState {
  /** A check has run (or runs): rows without a result are "not checked", not "waiting". */
  started: boolean;
  running: boolean;
  /** Null until the sign-in is answered. */
  signedIn: boolean | null;
  check: PersonCheck | null;
  sudo: 'ok' | 'skipped' | 'not_unlocked' | null;
}

const initialState: MachineCheckPageState = {
  started: false,
  running: false,
  signedIn: null,
  check: null,
  sudo: null,
};

/**
 * Settings → Machine check: the real chain as the signed-in person —
 * the Linux sign-in and the sudo prompt are the shell's own, the rest one request.
 */
export const MachineCheckPageStore = signalStore(
  withState<MachineCheckPageState>(initialState),
  withComputed((store, linuxSessionStore = inject(LinuxSessionStore)) => ({
    /** The signed-in Linux account, for the texts and commands. */
    account: computed(() => linuxSessionStore.session()?.username ?? ''),
  })),
  withComputed((store) => ({
    steps: computed<MachineCheckStep[]>(() => {
      const check = store.check();
      const results: Partial<Record<MachineCheckStepId, Omit<MachineCheckStep, 'id'>>> = {};
      if (store.signedIn() === true) results.signIn = { status: 'ok', text: 'signIn.ok' };
      if (store.signedIn() === false)
        results.signIn = { status: 'not_checked', text: 'signIn.notSignedIn' };
      if (check) {
        results.helper =
          check.helper === 'ok'
            ? { status: 'ok', text: 'helper.ok' }
            : { status: 'failed', text: `helper.${check.helper}` };
        if (check.userUnits === false) {
          results.userUnits = { status: 'failed', text: 'userUnits.failed' };
        } else if (check.userUnits && check.lingering === false) {
          results.userUnits = { status: 'failed', text: 'userUnits.noLingering' };
        } else if (check.userUnits) {
          results.userUnits = { status: 'ok', text: 'userUnits.ok' };
        }
        if (check.docker) results.docker = { status: 'info', text: `docker.${check.docker}` };
      }
      const sudo = store.sudo();
      if (sudo === 'ok') results.sudo = { status: 'ok', text: 'sudo.ok' };
      if (sudo === 'skipped') results.sudo = { status: 'skipped', text: 'sudo.skipped' };
      if (sudo === 'not_unlocked')
        results.sudo = { status: 'not_checked', text: 'sudo.notUnlocked' };

      let current = store.running();
      return STEPS.map((id) => {
        const result = results[id];
        if (result) {
          const command = COMMANDS[result.text]?.(store.account());
          return { id, ...result, text: `machineCheck.steps.${result.text}`, command };
        }
        // The first step without a result is the one running; after a check, the rest weren't checked.
        if (current) {
          current = false;
          return { id, status: 'running', text: `machineCheck.steps.${id}.about` };
        }
        return store.started() && !store.running()
          ? { id, status: 'not_checked', text: 'machineCheck.notChecked' }
          : { id, status: 'waiting', text: `machineCheck.steps.${id}.about` };
      });
    }),
  })),
  withMethods(
    (
      store,
      machineCheckApi = inject(MachineCheckApi),
      linuxSessionStore = inject(LinuxSessionStore),
      translator = inject(Translator),
    ) => ({
      /** Every step; `withoutSudo` for an account meant to have none. */
      _run(withoutSudo: boolean): Observable<unknown> {
        return defer(() => {
          patchState(store, { ...initialState, started: true, running: true });
          return linuxSessionStore.asPerson$(() => machineCheckApi.person());
        }).pipe(
          concatMap((check) => {
            if (!check) {
              patchState(store, { signedIn: false });
              return EMPTY;
            }
            patchState(store, { signedIn: true, check });
            if (check.helper !== 'ok') return EMPTY;
            if (withoutSudo) {
              patchState(store, { sudo: 'skipped' });
              return EMPTY;
            }
            // Unlocked as the server sees it (ilex-root may have ended meanwhile); otherwise the
            // prompt, which says what sudo answered.
            return linuxSessionStore.refresh$().pipe(
              concatMap(() =>
                linuxSessionStore.sudoMinutes() !== null
                  ? of(true)
                  : linuxSessionStore.withSudo$(() => of(true)),
              ),
              tap((unlocked) =>
                patchState(store, { sudo: unlocked === true ? 'ok' : 'not_unlocked' }),
              ),
            );
          }),
          catchError((error: unknown) => {
            if (store.signedIn() === null && linuxSessionStore.session()) {
              patchState(store, { signedIn: true });
            }
            toast.error(translator.t('machineCheck.failed'), {
              description: translator.t(...apiErrorText(error)),
            });
            return EMPTY;
          }),
          finalize(() => patchState(store, { running: false })),
        );
      },
    }),
  ),
  withMethods((store) => ({
    // One check at a time, whichever button started it.
    run: rxMethod<void>(pipe(exhaustMap(() => (store.running() ? EMPTY : store._run(false))))),

    runWithoutSudo: rxMethod<void>(
      pipe(exhaustMap(() => (store.running() ? EMPTY : store._run(true)))),
    ),
  })),
  // Whether a Linux session is open: the check then starts without the sign-in.
  withHooks((_store, linuxSessionStore = inject(LinuxSessionStore)) => ({
    onInit() {
      linuxSessionStore.check();
    },
  })),
);
