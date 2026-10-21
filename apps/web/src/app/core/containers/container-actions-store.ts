import { effect, inject } from '@angular/core';
import { patchState, signalStore, withHooks, withMethods, withState } from '@ngrx/signals';
import type { ContainerAction } from '@laris/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { AuthStore } from '../auth/auth-store';
import { Translator } from '../i18n/translator';
import { apiErrorText } from '../../shared/forms/submission-errors';
import { ContainersApi } from './containers-api';

interface ContainerActionsState {
  /** The action in progress for each container name. */
  pending: ReadonlyMap<string, ContainerAction>;
}

const initialState: ContainerActionsState = { pending: new Map() };

/** Keeps a container name in one direction inside a translated sentence (toasts are plain text). */
const isolate = (name: string) => `⁨${name}⁩`;

/**
 * Container actions (start, stop, restart — already confirmed where needed): marks the container
 * as busy while Docker works, then says how it went in a toast. Global, because every page that
 * shows a container (dashboard, Containers) must show it as busy; reset on sign-out.
 */
export const ContainerActionsStore = signalStore(
  { providedIn: 'root' },
  withState<ContainerActionsState>(initialState),
  withMethods((store, api = inject(ContainersApi), translator = inject(Translator)) => ({
    async run(name: string, action: ContainerAction): Promise<void> {
      if (store.pending().has(name)) return;
      patchState(store, { pending: new Map(store.pending()).set(name, action) });
      try {
        await api.act(name, action);
        toast.success(translator.t(`containers.done.${action}`, { name: isolate(name) }));
      } catch (error) {
        toast.error(translator.t(`containers.failed.${action}`, { name: isolate(name) }), {
          description: translator.t(...apiErrorText(error)),
        });
      } finally {
        const pending = new Map(store.pending());
        pending.delete(name);
        patchState(store, { pending });
      }
    },
  })),
  withHooks((store, auth = inject(AuthStore)) => ({
    onInit() {
      effect(() => {
        if (!auth.isAuthenticated()) patchState(store, initialState);
      });
    },
  })),
);
