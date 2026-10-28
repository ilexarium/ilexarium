import { Component, computed, inject, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideLock,
  lucideLogOut,
  lucideShieldCheck,
  lucideSquareTerminal,
} from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import { HlmDropdownMenuImports } from '@ui/dropdown-menu';
import { Translator } from '../../core/i18n/translator';
import { PluralPipe } from '../../core/i18n/plural-pipe';

/**
 * The top bar's Linux session: the account, and while its sudo is unlocked, about how many
 * minutes are left (an estimate: sudo decides). Its menu locks sudo now (the session ends with
 * it), or closes the session. Shown only while signed in to Linux; UI only.
 */
@Component({
  selector: 'laris-linux-status',
  imports: [HlmButton, HlmDropdownMenuImports, NgIcon, PluralPipe, TranslatePipe],
  providers: [provideIcons({ lucideLock, lucideLogOut, lucideShieldCheck, lucideSquareTerminal })],
  templateUrl: './linux-status.html',
})
export class LinuxStatus {
  readonly username = input.required<string>();
  /** Whole minutes of sudo left; null while locked. */
  readonly sudoMinutes = input<number | null>(null);
  readonly lock = output<void>();
  readonly close = output<void>();

  private readonly translator = inject(Translator);
  protected readonly label = computed(() => {
    const minutes = this.sudoMinutes();
    return minutes === null
      ? this.translator.t('linux.status.label', { account: this.username() })
      : this.translator.plural('linux.status.labelAdmin', minutes, { account: this.username() });
  });
}
