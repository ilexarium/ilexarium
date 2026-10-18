import { Component, inject, signal } from '@angular/core';
import { form, FormField, FormRoot, validateStandardSchema } from '@angular/forms/signals';
import { type LinuxSignInRequest, linuxSignInRequestSchema } from '@homelab/shared';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertImports } from '@ui/alert';
import { HlmButton } from '@ui/button';
import { HlmCardImports } from '@ui/card';
import { HlmFieldImports } from '@ui/field';
import { HlmInput } from '@ui/input';
import { ErrorTextPipe } from '../../../shared/forms/error-text-pipe';
import { PasswordToggle } from '../../../shared/forms/password-toggle';
import { toSubmissionErrors } from '../../../shared/forms/submission-errors';
import { FilesPageStore } from '../files-page/files-page-store';

/** Signing in as a Linux user of this machine (sshd checks the password). Submits through the page store. */
@Component({
  selector: 'app-files-sign-in',
  imports: [
    ErrorTextPipe,
    FormField,
    FormRoot,
    HlmAlertImports,
    HlmButton,
    HlmCardImports,
    HlmFieldImports,
    HlmInput,
    PasswordToggle,
    TranslatePipe,
  ],
  templateUrl: './files-sign-in.html',
})
export class FilesSignIn {
  private readonly store = inject(FilesPageStore);
  protected readonly showPassword = signal(false);
  private readonly model = signal<LinuxSignInRequest>({ username: '', password: '' });
  protected readonly form = form(
    this.model,
    (path) => validateStandardSchema(path, linuxSignInRequestSchema),
    {
      submission: {
        action: async (tree) => {
          try {
            await this.store.signIn(tree().value());
          } catch (error) {
            return toSubmissionErrors(error, tree);
          }
          return undefined;
        },
      },
    },
  );
}
