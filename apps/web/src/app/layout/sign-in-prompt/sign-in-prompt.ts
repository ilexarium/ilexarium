import { Component, inject } from '@angular/core';
import type { LinuxSignInRequest } from '@ilex/shared';
import { LinuxSessionStore } from '../../core/linux/linux-session-store';
import { SignInDialog } from '../../shared/sign-in-dialog/sign-in-dialog';

/**
 * The Linux sign-in asked while a change waits for it (any page's, through
 * `LinuxSessionStore.asPerson`): Ilexarium does it as that account; signed in, the change carries on.
 */
@Component({
  selector: 'ilex-sign-in-prompt',
  imports: [SignInDialog],
  templateUrl: './sign-in-prompt.html',
})
export class SignInPrompt {
  protected readonly linuxSessionStore = inject(LinuxSessionStore);
  protected readonly signIn = (request: LinuxSignInRequest) =>
    this.linuxSessionStore.signIn(request);
}
