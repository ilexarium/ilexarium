import { Component, input, output, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { ChatSummary } from '@homelab/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucidePlus, lucideTrash2 } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertDialog, HlmAlertDialogImports } from '@ui/alert-dialog';
import { HlmButton } from '@ui/button';

/**
 * The person's chats, newest first, each a link; "New chat" on top; Delete after a confirmation.
 * Presentational: a confirmed Delete goes out through `remove`, a chosen link through `picked`
 * (on phones, the sheet closes).
 */
@Component({
  selector: 'app-chat-list',
  imports: [HlmAlertDialogImports, HlmButton, NgIcon, RouterLink, TranslatePipe],
  providers: [provideIcons({ lucidePlus, lucideTrash2 })],
  host: { class: 'flex min-h-0 flex-col gap-2' },
  templateUrl: './chat-list.html',
})
export class ChatList {
  readonly chats = input.required<ChatSummary[]>();
  /** The open chat's id; null for a new chat. */
  readonly selected = input<string | null>(null);

  readonly remove = output<string>();
  readonly picked = output<void>();

  protected readonly asking = signal<ChatSummary | null>(null);
  private readonly dialog = viewChild.required(HlmAlertDialog);

  protected confirmRemove(chat: ChatSummary): void {
    this.asking.set(chat);
    this.dialog().open();
  }

  protected confirmed(): void {
    const chat = this.asking();
    this.dialog().close();
    if (chat) this.remove.emit(chat.id);
  }
}
