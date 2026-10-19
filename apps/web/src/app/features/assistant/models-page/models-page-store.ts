import { computed, inject } from '@angular/core';
import {
  patchState,
  signalStore,
  withComputed,
  withHooks,
  withMethods,
  withState,
} from '@ngrx/signals';
import type { AiLibraryDetail, AiLibraryModel, AiModel, AiPull, AiStatus } from '@homelab/shared';
import { toast } from '@spartan-ng/brain/sonner';
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
  withMethods((store, api = inject(AssistantApi), translator = inject(Translator)) => {
    const failed = (key: string, error: unknown, params?: Record<string, unknown>) =>
      toast.error(translator.t(key, params), { description: translator.t(...apiErrorText(error)) });

    const loadModels = async (): Promise<void> => {
      try {
        patchState(store, { models: (await api.models()).models });
      } catch (error) {
        failed('assistant.loadFailed', error);
      }
    };

    return {
      async load(): Promise<void> {
        try {
          const status = await api.status();
          patchState(store, { status });
          if (status.state === 'ready') await loadModels();
        } catch (error) {
          failed('assistant.loadFailed', error);
        }
      },

      /** A topic update: when a download ends, the list is read again and the person told. */
      pullChanged(pull: AiPull | null): void {
        const before = store.pull();
        patchState(store, { pull });
        if (!pull || before?.status !== 'running' || pull.status === 'running') return;
        if (before.model !== pull.model) return;
        if (pull.status === 'succeeded') {
          toast.success(translator.t('assistant.pulled', { model: pull.model }));
          void loadModels();
        } else {
          toast.error(translator.t('assistant.pullFailed', { model: pull.model }), {
            description: translator.t(`errors.${pull.errorCode ?? 'pull_failed'}`),
          });
        }
      },

      /** Starts a download; throws when refused (so a form keeps its text). */
      async download(model: string): Promise<void> {
        try {
          const started = await api.pull(model);
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
          await api.removeModel(model);
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
          patchState(store, { results: (await api.search(text)).models });
        } catch (error) {
          failed('assistant.searchFailed', error);
        } finally {
          patchState(store, { searching: false });
        }
      },

      /** Opens a result (its sizes), or closes it again. */
      async toggle(id: string): Promise<void> {
        if (store.opened()?.id === id) {
          patchState(store, { opened: null });
          return;
        }
        patchState(store, { opened: { id, detail: null } });
        try {
          const detail = await api.libraryDetail(id);
          if (store.opened()?.id === id) patchState(store, { opened: { id, detail } });
        } catch (error) {
          if (store.opened()?.id === id) patchState(store, { opened: null });
          failed('assistant.searchFailed', error);
        }
      },
    };
  }),
  withHooks((store, realtime = inject(RealtimeService)) => {
    let stop: (() => void) | null = null;
    return {
      onInit() {
        void store.load();
        stop = realtime.subscribe('assistant', (message) => {
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
