import { effect, inject } from '@angular/core';
import { patchState, signalStore, withHooks, withMethods, withState } from '@ngrx/signals';
import type { ContainerAction, ContainerActionParams } from '@ilex/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import { catchError, EMPTY, finalize, forkJoin, map, mergeMap, of, pipe, tap } from 'rxjs';
import { AuthStore } from '../auth/auth-store';
import { Translator } from '../i18n/translator';
import { Formatter } from '../../shared/format/formatter';
import { apiErrorText } from '../../shared/forms/submission-errors';
import { ContainersApi } from './containers-api';
import type { ContainerGroupAction } from './containers.model';

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
      /** One container; containers side by side, a repeat while one runs ignored. */
      run: rxMethod<ContainerActionParams>(
        pipe(
          mergeMap(({ name, action }) => {
            if (store.pending().has(name)) return EMPTY;
            patchState(store, { pending: new Map(store.pending()).set(name, action) });
            return containersApi.act(name, action).pipe(
              tap(() =>
                toast.success(
                  translator.t(`containers.done.${action}`, { name: formatter.machine(name) }),
                ),
              ),
              catchError((error: unknown) => {
                toast.error(
                  translator.t(`containers.failed.${action}`, { name: formatter.machine(name) }),
                  { description: translator.t(...apiErrorText(error)) },
                );
                return EMPTY;
              }),
              finalize(() => {
                const pending = new Map(store.pending());
                pending.delete(name);
                patchState(store, { pending });
              }),
            );
          }),
        ),
      ),

      /** Several containers of one app at once, with one toast in the app's name. */
      runAll: rxMethod<ContainerGroupAction>(
        pipe(
          mergeMap(({ names, action, label }) => {
            const free = names.filter((name) => !store.pending().has(name));
            if (free.length === 0) return EMPTY;
            const pending = new Map(store.pending());
            for (const name of free) pending.set(name, action);
            patchState(store, { pending });
            return forkJoin(
              free.map((name) =>
                containersApi.act(name, action).pipe(
                  map(() => null),
                  catchError((error: unknown) => of({ error })),
                ),
              ),
            ).pipe(
              tap((results) => {
                const failures = results.filter((r) => r !== null);
                if (failures.length > 0) {
                  // Some of them done: say so, so it isn't taken for nothing having happened.
                  const title = failures.length < free.length ? 'partly' : 'failed';
                  toast.error(translator.t(`containers.${title}.${action}`, { name: label }), {
                    description: translator.t(...apiErrorText(failures[0].error)),
                  });
                } else {
                  toast.success(translator.t(`containers.done.${action}`, { name: label }));
                }
              }),
              finalize(() => {
                const rest = new Map(store.pending());
                for (const name of free) rest.delete(name);
                patchState(store, { pending: rest });
              }),
            );
          }),
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
