import { Component, model } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideEye, lucideEyeOff } from '@ng-icons/lucide';
import { HlmButton } from '@ui/button';

/** Show/hide button for password fields. Place inside a `relative` wrapper around the input. */
@Component({
  selector: 'app-password-toggle',
  imports: [NgIcon, HlmButton],
  providers: [provideIcons({ lucideEye, lucideEyeOff })],
  template: `
    <button
      hlmBtn
      type="button"
      variant="ghost"
      size="icon"
      class="absolute top-0 right-0"
      [attr.aria-label]="visible() ? 'Hide passwords' : 'Show passwords'"
      [attr.aria-pressed]="visible()"
      (click)="visible.set(!visible())"
    >
      <ng-icon [name]="visible() ? 'lucideEyeOff' : 'lucideEye'" aria-hidden="true" />
    </button>
  `,
})
export class PasswordToggle {
  readonly visible = model(false);
}
