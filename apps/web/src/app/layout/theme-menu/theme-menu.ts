import { Component, computed, inject } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideMoon, lucideSun } from '@ng-icons/lucide';
import { HlmButton } from '@ui/button';
import { HlmDropdownMenuImports } from '@ui/dropdown-menu';
import { type ThemeChoice, ThemeService } from '../../core/theme/theme';

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
  template: `
    <button
      hlmBtn
      variant="ghost"
      size="icon"
      [hlmDropdownMenuTrigger]="menu"
      align="end"
      [attr.aria-label]="label()"
    >
      <ng-icon [name]="theme.dark() ? 'lucideMoon' : 'lucideSun'" aria-hidden="true" />
    </button>
    <ng-template #menu>
      <hlm-dropdown-menu class="w-40">
        <div hlmDropdownMenuLabel>Theme</div>
        <div hlmDropdownMenuGroup>
          @for (option of options; track option.value) {
            <button
              hlmDropdownMenuRadio
              [checked]="theme.choice() === option.value"
              [keepOpen]="false"
              (triggered)="theme.setChoice(option.value)"
            >
              <hlm-dropdown-menu-radio-indicator />
              {{ option.label }}
            </button>
          }
        </div>
      </hlm-dropdown-menu>
    </ng-template>
  `,
})
export class ThemeMenu {
  protected readonly theme = inject(ThemeService);
  protected readonly options = OPTIONS;
  protected readonly label = computed(
    () => `Theme: ${OPTIONS.find((option) => option.value === this.theme.choice())!.label}`,
  );
}
