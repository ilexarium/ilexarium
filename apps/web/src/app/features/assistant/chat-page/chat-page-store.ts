import { computed, DOCUMENT, inject } from '@angular/core';
import {
  patchState,
  signalStore,
  withComputed,
  withHooks,
  withMethods,
  withState,
} from '@ngrx/signals';
import type { AiModel, AiStatus, Chat, ChatMessage, ChatSummary } from '@laris/shared';
import { toast } from '@spartan-ng/brain/sonner';
import type { Subscription } from 'rxjs';
import { AssistantApi } from '../../../core/assistant/assistant-api';
import { Translator } from '../../../core/i18n/translator';
import { readStored, writeStored } from '../../../core/storage/browser-storage';
import { apiErrorText } from '../../../shared/forms/submission-errors';
import { MODEL_STORAGE_KEY } from '../assistant.constants';
import type { StreamingAnswer } from '../assistant.model';

interface ChatPageState {
  status: AiStatus | null;
  models: AiModel[];
  chats: ChatSummary[];
  /** The open chat; null for a new one. */
  chat: Chat | null;
  loadingChat: boolean;
  /** The model the next message goes to. */
  model: string | null;
  /** The answer being written, null when none. */
  streaming: StreamingAnswer | null;
}

const initialState: ChatPageState = {
  status: null,
  models: [],
  chats: [],
  chat: null,
  loadingChat: false,
  model: null,
  streaming: null,
};

/**
 * The Assistant's chat page (docs/plans/ai_assistant.md): Ollama's state, the installed models,
 * the person's chats and the open one, and sending — the answer streams into `streaming` and is
 * added to the chat when done. Leaving the page stops an answer (the server keeps the part written).
 */
export const ChatPageStore = signalStore(
  withState<ChatPageState>(initialState),
  withComputed((store) => ({
    ready: computed(() => store.status()?.state === 'ready'),
    sending: computed(() => store.streaming() !== null),
  })),
  withMethods(
    (
      store,
      assistantApi = inject(AssistantApi),
      translator = inject(Translator),
      defaultView = inject(DOCUMENT).defaultView,
    ) => {
      let answer: Subscription | null = null;
      /** Settles `send()`'s promise while the message isn't accepted yet (no `chat` line). */
      let unaccepted: ((error?: unknown) => void) | null = null;
      /** The chat asked for last: an earlier one answering later is ignored. */
      let opening: string | null = null;

      /** A model that is installed: the wished one, else the last chosen here, else the first. */
      const pick = (wished: string | null): string | null => {
        const names = store.models().map((model) => model.name);
        for (const name of [wished, store.model(), readStored(defaultView, MODEL_STORAGE_KEY)]) {
          if (name && names.includes(name)) return name;
        }
        return names[0] ?? null;
      };
      const addMessage = (message: ChatMessage) => {
        const chat = store.chat();
        if (chat) patchState(store, { chat: { ...chat, messages: [...chat.messages, message] } });
      };
      const failed = (key: string, error: unknown) =>
        toast.error(translator.t(key), { description: translator.t(...apiErrorText(error)) });

      /** Stops the answer being written; the part written stays (the server keeps it too). */
      const stop = (): void => {
        if (!answer) return;
        answer.unsubscribe();
        answer = null;
        // Stopped before the server took it: the form keeps the text.
        unaccepted?.(new Error('stopped'));
        unaccepted = null;
        const text = store.streaming()?.text ?? '';
        const model = store.model();
        if (text && model) {
          addMessage({
            id: `stopped-${Date.now()}`,
            role: 'assistant',
            content: text,
            model,
            stopped: true,
            createdAt: new Date().toISOString(),
          });
        }
        patchState(store, { streaming: null });
      };

      return {
        async load(): Promise<void> {
          try {
            const status = await assistantApi.status();
            patchState(store, { status });
            if (status.state !== 'ready') return;
            const [{ models }, { chats }] = await Promise.all([
              assistantApi.models(),
              assistantApi.chats(),
            ]);
            patchState(store, { models, chats });
            patchState(store, { model: pick(store.chat()?.model ?? null) });
          } catch (error) {
            failed('assistant.loadFailed', error);
          }
        },

        /** Opens a saved chat, or (null) starts a new one. */
        async open(id: string | null): Promise<void> {
          // Already open: the URL just caught up with a new chat (its answer goes on).
          if (id && store.chat()?.id === id) return;
          stop();
          opening = id;
          if (!id) {
            patchState(store, { chat: null, loadingChat: false });
            return;
          }
          patchState(store, { loadingChat: true });
          try {
            const chat = await assistantApi.chat(id);
            if (opening !== id) return; // another chat was opened meanwhile
            patchState(store, { chat, model: pick(chat.model) });
          } catch (error) {
            if (opening !== id) return;
            patchState(store, { chat: null });
            failed('assistant.openFailed', error);
          } finally {
            if (opening === id) patchState(store, { loadingChat: false });
          }
        },

        setModel(model: string): void {
          patchState(store, { model });
          writeStored(defaultView, MODEL_STORAGE_KEY, model);
        },

        /**
         * Sends a message; resolves once it's accepted (or refused: then it throws, so the form
         * keeps the text). The answer goes on streaming after that.
         */
        send(content: string): Promise<void> {
          const model = store.model();
          if (!model || answer) return Promise.resolve();
          patchState(store, { streaming: { text: '' } });
          return new Promise<void>((resolve, reject) => {
            unaccepted = (error) => (error ? reject(error) : resolve());
            answer = assistantApi
              .send({ chatId: store.chat()?.id ?? null, model, content })
              .subscribe({
                next: (event) => {
                  switch (event.type) {
                    case 'chat': {
                      const current = store.chat();
                      const chat: Chat =
                        current?.id === event.chat.id
                          ? { ...current, model: event.chat.model }
                          : { ...event.chat, createdAt: event.question.createdAt, messages: [] };
                      patchState(store, {
                        chat: { ...chat, messages: [...chat.messages, event.question] },
                        chats: [event.chat, ...store.chats().filter((c) => c.id !== event.chat.id)],
                      });
                      opening = event.chat.id;
                      unaccepted = null;
                      resolve();
                      break;
                    }
                    case 'text':
                      patchState(store, {
                        streaming: { text: (store.streaming()?.text ?? '') + event.text },
                      });
                      break;
                    case 'done':
                      addMessage(event.answer);
                      break;
                    case 'error':
                      if (event.answer) addMessage(event.answer);
                      toast.error(translator.t('assistant.answerFailed'), {
                        description: translator.t(`errors.${event.code}`),
                      });
                      break;
                  }
                },
                error: (error: unknown) => {
                  answer = null;
                  unaccepted = null;
                  patchState(store, { streaming: null });
                  failed('assistant.sendFailed', error);
                  reject(error);
                },
                complete: () => {
                  answer = null;
                  patchState(store, { streaming: null });
                  // Ended without taking the message (no `chat` line): the form keeps the text.
                  unaccepted?.(new Error('not accepted'));
                  unaccepted = null;
                },
              });
          });
        },

        /** Stops the answer being written; the part written stays (the server keeps it too). */
        stop,

        async remove(id: string): Promise<boolean> {
          try {
            await assistantApi.removeChat(id);
          } catch (error) {
            failed('assistant.removeChatFailed', error);
            return false;
          }
          patchState(store, { chats: store.chats().filter((chat) => chat.id !== id) });
          if (store.chat()?.id === id) patchState(store, { chat: null });
          return true;
        },
      };
    },
  ),
  withHooks((store) => ({
    onInit() {
      void store.load();
    },
    onDestroy() {
      store.stop();
    },
  })),
);
