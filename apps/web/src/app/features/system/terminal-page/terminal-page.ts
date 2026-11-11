import {
  Component,
  computed,
  effect,
  type ElementRef,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type { LinuxSignInRequest } from '@ilex/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideX } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import { HlmSkeleton } from '@ui/skeleton';
import { ThemeService } from '../../../core/theme/theme';
import { Formatter } from '../../../shared/format/formatter';
import { EmptyState } from '../../../shared/empty-state/empty-state';
import { SignInDialog } from '../../../shared/sign-in-dialog/sign-in-dialog';
import { TerminalView } from '../terminal-view/terminal-view';
import type { TerminalSize } from '../terminal.model';
import { TerminalPageStore } from './terminal-page-store';

/**
 * The Terminal page: a shell of your Linux account in
 * the browser — the Linux sign-in, then the app password again for each terminal (one dialog),
 * then the terminal; why it closed, and opening it again.
 */
@Component({
  selector: 'ilex-terminal-page',
  imports: [EmptyState, HlmButton, HlmSkeleton, NgIcon, SignInDialog, TerminalView, TranslatePipe],
  providers: [TerminalPageStore, provideIcons({ lucideX })],
  templateUrl: './terminal-page.html',
  host: { class: 'flex min-h-[calc(100dvh-7rem)] flex-col' },
})
export class TerminalPage {
  protected readonly terminalPageStore = inject(TerminalPageStore);
  protected readonly themeService = inject(ThemeService);
  protected readonly formatter = inject(Formatter);
  private readonly view = viewChild<TerminalView>('view');
  private readonly signInButton = viewChild<ElementRef<HTMLButtonElement>>('signInButton');

  /** Opens on its own once, on arrival; then only from the button. */
  protected readonly signInOpen = signal(false);
  protected readonly terminalShown = computed(() => {
    const phase = this.terminalPageStore.phase();
    return !!this.terminalPageStore.session() && (phase === 'connecting' || phase === 'open');
  });
  protected readonly signIn = (request: LinuxSignInRequest) =>
    this.terminalPageStore.signIn(request);
  protected readonly unlock = (password: string) => this.terminalPageStore.unlock(password);

  constructor() {
    let arrived = false;
    effect(() => {
      if (arrived || !this.terminalPageStore.checked()) return;
      arrived = true;
      untracked(() => this.signInOpen.set(true));
    });
  }

  /** Focus back to the page: its button, or the terminal just opened. */
  protected signInClosed(): void {
    this.signInOpen.set(false);
    const button = this.signInButton();
    if (button) button.nativeElement.focus();
    else this.view()?.focus();
  }

  protected connect(size: TerminalSize): void {
    this.terminalPageStore.connect(size, (bytes) => this.view()?.write(bytes));
  }
}
