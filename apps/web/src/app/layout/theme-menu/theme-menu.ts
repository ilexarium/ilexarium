import { Component, computed, inject } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideMoon, lucideSun } from '@ng-icons/lucide';
import { HlmButton } from '@ui/button';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmDropdownMenuImports } from '@ui/dropdown-menu';
import { Translator } from '../../core/i18n/translator';
import { ThemeService } from '../../core/theme/theme';
import type { ThemeChoice } from '../../core/theme/theme.model';

/** `label`: translation key. */
const OPTIONS: { value: ThemeChoice; label: string }[] = [
  { value: 'light', label: 'theme.light' },
  { value: 'dark', label: 'theme.dark' },
  { value: 'system', label: 'theme.system' },
];

/** The top-bar theme switch: Light, Dark or System (follow the device). */
@Component({
  selector: 'laris-theme-menu',
  imports: [HlmButton, HlmDropdownMenuImports, NgIcon, TranslatePipe],
  providers: [provideIcons({ lucideMoon, lucideSun })],
  templateUrl: './theme-menu.html',
})
export class ThemeMenu {
  protected readonly theme = inject(ThemeService);
  protected readonly options = OPTIONS;
  private readonly translator = inject(Translator);
  protected readonly label = computed(() => {
    const option = OPTIONS.find((o) => o.value === this.theme.choice())!;
    return this.translator.t('theme.current', { choice: this.translator.t(option.label) });
  });
}
