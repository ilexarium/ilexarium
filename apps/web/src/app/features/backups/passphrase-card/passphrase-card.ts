import { Component, computed, inject, input, output, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCheck, lucideCopy, lucideKeyRound } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertImports } from '@ui/alert';
import { HlmButton } from '@ui/button';
import { HlmCardImports } from '@ui/card';
import { Translator } from '../../../core/i18n/translator';
import { toast } from '@spartan-ng/brain/sonner';

/**
 * The backup passphrase, shown once after setup (and again on request): six words to keep in a
 * password manager or on paper — without it, the backups can't be opened on another machine.
 * UI only: "I've saved it" reports `saved`, and the page forgets the passphrase.
 */
@Component({
  selector: 'laris-passphrase-card',
  imports: [HlmAlertImports, HlmButton, HlmCardImports, NgIcon, TranslatePipe],
  providers: [provideIcons({ lucideCheck, lucideCopy, lucideKeyRound })],
  templateUrl: './passphrase-card.html',
})
export class PassphraseCard {
  readonly passphrase = input.required<string>();
  /** First shown after setup: the stronger wording. */
  readonly first = input(false);

  readonly saved = output<void>();

  private readonly translator = inject(Translator);
  protected readonly words = computed(() => this.passphrase().split(' '));
  protected readonly copied = signal(false);

  protected async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.passphrase());
      this.copied.set(true);
    } catch {
      toast.error(this.translator.t('backups.passphrase.copyFailed'));
    }
  }
}
