import { computed, inject } from '@angular/core';
import {
  patchState,
  signalStore,
  withComputed,
  withHooks,
  withMethods,
  withState,
} from '@ngrx/signals';
import type { AiLibraryDetail, AiLibraryModel, AiModel, AiPull, AiStatus } from '@laris/shared';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import { toast } from '@spartan-ng/brain/sonner';
import { catchError, EMPTY, exhaustMap, firstValueFrom, pipe, switchMap, tap } from 'rxjs';
import { AssistantApi } from '../../../core/assistant/assistant-api';
import { Translator } from '../../../core/i18n/translator';
import { RealtimeService } from '../../../core/realtime/realtime-service';
import { apiErrorText } from '../../../shared/forms/submission-errors';

interface ModelsPageState {
  status: AiStatus | null;
  models: AiModel[];
  /** The current or last download (the `assistant` topic). */
  pull: AiPull | null;
  /** Models being removed. */
  removing: string[];
  /** Null until searched. */
  results: AiLibraryModel[] | null;
  searching: boolean;
  /** The repository opened in the results, its sizes once loaded. */
  opened: { id: string; detail: AiLibraryDetail | null } | null;
}

const initialState: ModelsPageState = {
  status: null,
  models: [],
  pull: null,
  removing: [],
  results: null,
  searching: false,
  opened: null,
};

/**
 * The Assistant's models (docs/plans/ai_assistant.md): installed ones (remove), downloads (by
 * name or from Hugging Face; progress through the `assistant` topic while the page is open) and
 * the Hugging Face search. Page-scoped.
 */
export const ModelsPageStore = signalStore(
  withState<ModelsPageState>(initialState),
  withComputed((store) => ({
    downloading: computed(() => store.pull()?.status === 'running'),
    totalBytes: computed(() => store.models().reduce((sum, model) => sum + model.sizeBytes, 0)),
  })),
  withMethods((store, assistantApi = inject(AssistantApi), translator = inject(Translator)) => {
    const failed = (key: string, error: unknown, params?: Record<string, unknown>) =>
      toast.error(translator.t(key, params), { description: translator.t(...apiErrorText(error)) });

    // After a download too: the latest answer wins.
    const loadModels = rxMethod<void>(
      pipe(
        switchMap(() =>
          assistantApi.models().pipe(
            tap(({ models }) => patchState(store, { models })),
            catchError((error: unknown) => {
              failed('assistant.loadFailed', error);
              return EMPTY;
            }),
          ),
        ),
      ),
    );

    return {
      load: rxMethod<void>(
        pipe(
          exhaustMap(() =>
            assistantApi.status().pipe(
              tap((status) => {
                patchState(store, { status });
                if (status.state === 'ready') loadModels();
              }),
              catchError((error: unknown) => {
                failed('assistant.loadFailed', error);
                return EMPTY;
              }),
            ),
          ),
        ),
      ),

      /** A topic update: when a download ends, the list is read again and the person told. */
      pullChanged(pull: AiPull | null): void {
        const before = store.pull();
        patchState(store, { pull });
        if (!pull || before?.status !== 'running' || pull.status === 'running') return;
        if (before.model !== pull.model) return;
        if (pull.status === 'succeeded') {
          toast.success(translator.t('assistant.pulled', { model: pull.model }));
          loadModels();
        } else {
          toast.error(translator.t('assistant.pullFailed', { model: pull.model }), {
            description: translator.t(`errors.${pull.errorCode ?? 'pull_failed'}`),
          });
        }
      },

      /** Starts a download; throws when refused (so a form keeps its text). */
      async download(model: string): Promise<void> {
        try {
          const started = await firstValueFrom(assistantApi.pull(model));
          // The topic may already have said how it ended (a quick download): keep that.
          const known = store.pull();
          if (known?.startedAt !== started.startedAt || known.status === 'running') {
            patchState(store, { pull: started });
          }
        } catch (error) {
          failed('assistant.pullFailed', error, { model });
          throw error;
        }
      },

      async remove(model: string): Promise<void> {
        patchState(store, { removing: [...store.removing(), model] });
        try {
          await firstValueFrom(assistantApi.removeModel(model));
          patchState(store, { models: store.models().filter((m) => m.name !== model) });
          toast.success(translator.t('assistant.removed', { model }));
        } catch (error) {
          failed('assistant.removeFailed', error, { model });
        } finally {
          patchState(store, { removing: store.removing().filter((m) => m !== model) });
        }
      },

      async search(text: string): Promise<void> {
        patchState(store, { searching: true, opened: null });
        try {
          patchState(store, { results: (await firstValueFrom(assistantApi.search(text))).models });
        } catch (error) {
          failed('assistant.searchFailed', error);
        } finally {
          patchState(store, { searching: false });
        }
      },

      /** Opens a result (its sizes), or closes it again; another one opened meanwhile wins. */
      toggle: rxMethod<string>(
        pipe(
          switchMap((id) => {
            if (store.opened()?.id === id) {
              patchState(store, { opened: null });
              return EMPTY;
            }
            patchState(store, { opened: { id, detail: null } });
            return assistantApi.libraryDetail(id).pipe(
              // A new search closes it meanwhile.
              tap((detail) => {
                if (store.opened()?.id === id) patchState(store, { opened: { id, detail } });
              }),
              catchError((error: unknown) => {
                if (store.opened()?.id === id) patchState(store, { opened: null });
                failed('assistant.searchFailed', error);
                return EMPTY;
              }),
            );
          }),
        ),
      ),
    };
  }),
  withHooks((store, realtimeService = inject(RealtimeService)) => {
    let stop: (() => void) | null = null;
    return {
      onInit() {
        store.load();
        stop = realtimeService.subscribe('assistant', (message) => {
          if (message.event === 'assistant:snapshot' || message.event === 'assistant:update') {
            store.pullChanged(message.data.pull);
          }
        });
      },
      onDestroy() {
        stop?.();
      },
    };
  }),
);
