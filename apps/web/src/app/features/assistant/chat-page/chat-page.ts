import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { form, FormField, FormRoot, validateStandardSchema } from '@angular/forms/signals';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { type ChatMessageForm, chatMessageFormSchema } from '@laris/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowUp,
  lucideMessagesSquare,
  lucideSlidersHorizontal,
  lucideSquare,
} from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import { HlmFieldImports } from '@ui/field';
import { HlmSelectImports } from '@ui/select';
import { HlmSheetImports } from '@ui/sheet';
import { HlmSkeleton } from '@ui/skeleton';
import { HlmTextarea } from '@ui/textarea';
import { map } from 'rxjs';
import { LanguageService } from '../../../core/i18n/language';
import { EmptyState } from '../../../shared/empty-state/empty-state';
import { ChatList } from '../chat-list/chat-list';
import { ChatThread } from '../chat-thread/chat-thread';
import { ChatPageStore } from './chat-page-store';
import { FieldErrors } from '../../../shared/forms/field-errors';

/**
 * Chat with a local model (docs/plans/ai_assistant.md): the chats beside the conversation (a
 * sheet on phones), the model picker, the message box (Enter sends, Shift+Enter a new line; Stop
 * while an answer is written). What the page does itself is UI: reading the route, keeping the
 * URL on the open chat.
 */
@Component({
  selector: 'laris-chat-page',
  imports: [
    ChatList,
    ChatThread,
    EmptyState,
    FieldErrors,
    FormField,
    FormRoot,
    HlmButton,
    HlmFieldImports,
    HlmSelectImports,
    HlmSheetImports,
    HlmSkeleton,
    HlmTextarea,
    NgIcon,
    RouterLink,
    TranslatePipe,
  ],
  providers: [
    ChatPageStore,
    provideIcons({ lucideArrowUp, lucideMessagesSquare, lucideSlidersHorizontal, lucideSquare }),
  ],
  host: { class: 'flex h-[calc(100dvh-5.5rem)] flex-col md:h-[calc(100dvh-6.5rem)]' },
  templateUrl: './chat-page.html',
})
export class ChatPage {
  protected readonly store = inject(ChatPageStore);
  private readonly router = inject(Router);
  private readonly language = inject(LanguageService);
  protected readonly sheetSide = computed(() => (this.language.dir() === 'rtl' ? 'right' : 'left'));

  /**
   * The chat in the URL (`?chat=<id>`); null for a new one. A query parameter, not a path: the
   * page — and an answer being written — stays when a new chat gets its URL.
   */
  private readonly routeChat = toSignal(
    inject(ActivatedRoute).queryParamMap.pipe(map((params) => params.get('chat'))),
    { initialValue: null },
  );

  private readonly model = signal<ChatMessageForm>({ content: '' });
  protected readonly message = form(
    this.model,
    (path) => validateStandardSchema(path, chatMessageFormSchema),
    {
      submission: {
        action: async (field) => {
          const { content } = field().value();
          try {
            await this.store.send(content);
          } catch {
            return undefined; // The store told why (a toast); the text stays.
          }
          this.message().reset({ content: '' });
          return undefined;
        },
      },
    },
  );

  constructor() {
    // The URL decides the open chat …
    effect(() => {
      const id = this.routeChat();
      untracked(() => void this.store.open(id));
    });
    // … and a new chat, once saved, gets its own URL. Only a new one: while another chat is
    // being opened, the URL already says which.
    effect(() => {
      const id = this.store.chat()?.id;
      if (id && untracked(this.routeChat) === null) {
        void this.router.navigate(['/assistant'], { queryParams: { chat: id }, replaceUrl: true });
      }
    });
  }

  /** Enter sends; Shift+Enter (and Enter while composing, e.g. an IME) makes a new line. */
  protected keydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    (event.target as HTMLTextAreaElement).form?.requestSubmit();
  }

  protected async remove(id: string): Promise<void> {
    const wasOpen = this.store.chat()?.id === id;
    if ((await this.store.remove(id)) && wasOpen) await this.router.navigate(['/assistant']);
  }
}
