import { effect, inject } from '@angular/core';
import { patchState, signalStore, withHooks, withMethods, withState } from '@ngrx/signals';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import type { ContainerAction, ContainerActionParams } from '@laris/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { catchError, EMPTY, filter, finalize, mergeMap, pipe, tap } from 'rxjs';
import { AuthStore } from '../auth/auth-store';
import { Translator } from '../i18n/translator';
import { Formatter } from '../../shared/format/formatter';
import { apiErrorText } from '../../shared/forms/submission-errors';
import { ContainersApi } from './containers-api';

interface ContainerActionsState {
  /** The action in progress for each container name. */
  pending: ReadonlyMap<string, ContainerAction>;
}

const initialState: ContainerActionsState = { pending: new Map() };

/** Global, because every page that shows a container must show it as busy. */
export const ContainerActionsStore = signalStore(
  { providedIn: 'root' },
  withState<ContainerActionsState>(initialState),
  withMethods(
    (
      store,
      containersApi = inject(ContainersApi),
      translator = inject(Translator),
      formatter = inject(Formatter),
    ) => ({
      run: rxMethod<ContainerActionParams>(
        pipe(
          filter(({ name }) => !store.pending().has(name)),
          tap(({ name, action }) =>
            patchState(store, { pending: new Map(store.pending()).set(name, action) }),
          ),
          mergeMap(({ name, action }) =>
            containersApi.act(name, action).pipe(
              tap(() =>
                toast.success(
                  translator.t(`containers.done.${action}`, { name: formatter.machine(name) }),
                ),
              ),
              catchError((error: unknown) => {
                toast.error(
                  translator.t(`containers.failed.${action}`, { name: formatter.machine(name) }),
                  {
                    description: translator.t(...apiErrorText(error)),
                  },
                );
                return EMPTY;
              }),
              finalize(() => {
                const pending = new Map(store.pending());
                pending.delete(name);
                patchState(store, { pending });
              }),
            ),
          ),
        ),
      ),
    }),
  ),
  withHooks((store, authStore = inject(AuthStore)) => ({
    onInit() {
      effect(() => {
        if (!authStore.isAuthenticated()) patchState(store, initialState);
      });
    },
  })),
);
