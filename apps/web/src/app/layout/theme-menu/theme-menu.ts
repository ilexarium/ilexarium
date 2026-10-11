import { Component, computed, inject } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideMoon, lucideSun } from '@ng-icons/lucide';
import { HlmButton } from '@ui/button';
import { HlmDropdownMenuImports } from '@ui/dropdown-menu';
import { ThemeService } from '../../core/theme/theme';
import type { ThemeChoice } from '../../core/theme/theme.model';

const OPTIONS: { value: ThemeChoice; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

/** The top-bar theme switch: Light, Dark or System (follow the device). */
@Component({
  selector: 'app-theme-menu',
  imports: [HlmButton, HlmDropdownMenuImports, NgIcon],
  providers: [provideIcons({ lucideMoon, lucideSun })],
  templateUrl: './theme-menu.html',
})
export class ThemeMenu {
  protected readonly theme = inject(ThemeService);
  protected readonly options = OPTIONS;
  protected readonly label = computed(
    () => `Theme: ${OPTIONS.find((option) => option.value === this.theme.choice())!.label}`,
  );
}
