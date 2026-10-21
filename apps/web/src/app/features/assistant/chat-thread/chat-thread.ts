import { Component, computed, input } from '@angular/core';
import type { ChatMessage } from '@laris/shared';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmBubbleImports } from '@ui/bubble';
import { HlmMarkerImports } from '@ui/marker';
import { HlmMessageImports } from '@ui/message';
import { HlmMessageScrollerImports } from '@ui/message-scroller';
import type { ThreadMessage } from '../assistant.model';
import { MarkdownView } from '../markdown-view/markdown-view';

/**
 * A conversation: the person's messages as bubbles at the end, the model's answers as Markdown
 * at the start, the answer being written last ("Thinking…" until its first words). Follows new
 * text while at the bottom; a button jumps back down. Presentational.
 */
@Component({
  selector: 'laris-chat-thread',
  imports: [
    HlmBubbleImports,
    HlmMarkerImports,
    HlmMessageImports,
    HlmMessageScrollerImports,
    MarkdownView,
    TranslatePipe,
  ],
  host: { class: 'relative block min-h-0' },
  templateUrl: './chat-thread.html',
})
export class ChatThread {
  readonly messages = input.required<ChatMessage[]>();
  /** The answer being written; null when none. */
  readonly streaming = input<string | null>(null);

  protected readonly rows = computed<ThreadMessage[]>(() => {
    const streaming = this.streaming();
    return streaming === null
      ? this.messages()
      : [...this.messages(), { id: 'streaming', role: 'assistant', content: streaming }];
  });
}
