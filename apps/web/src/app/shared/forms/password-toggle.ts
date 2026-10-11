import { Component, model } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideEye, lucideEyeOff } from '@ng-icons/lucide';
import { HlmButton } from '@ui/button';
import { TranslatePipe } from '@ngx-translate/core';

/** Show/hide button for password fields. Place inside a `relative` wrapper around the input. */
@Component({
  selector: 'app-password-toggle',
  imports: [HlmButton, NgIcon, TranslatePipe],
  providers: [provideIcons({ lucideEye, lucideEyeOff })],
  templateUrl: './password-toggle.html',
})
export class PasswordToggle {
  readonly visible = model(false);
}
