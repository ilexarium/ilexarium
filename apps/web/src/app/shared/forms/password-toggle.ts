import { Component, model } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideEye, lucideEyeOff } from '@ng-icons/lucide';
import { HlmButton } from '@ui/button';

/** Show/hide button for password fields. Place inside a `relative` wrapper around the input. */
@Component({
  selector: 'app-password-toggle',
  imports: [NgIcon, HlmButton],
  providers: [provideIcons({ lucideEye, lucideEyeOff })],
  templateUrl: './password-toggle.html',
})
export class PasswordToggle {
  readonly visible = model(false);
}
