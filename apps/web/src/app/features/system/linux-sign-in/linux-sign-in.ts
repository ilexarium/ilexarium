import { Component, input, signal } from '@angular/core';
import { form, FormField, FormRoot, validateStandardSchema } from '@angular/forms/signals';
import { type LinuxSignInRequest, linuxSignInRequestSchema } from '@laris/shared';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import { HlmCardImports } from '@ui/card';
import { HlmFieldImports } from '@ui/field';
import { HlmInput } from '@ui/input';
import { PasswordToggle } from '../../../shared/forms/password-toggle';
import { toSubmissionErrors } from '../../../shared/forms/submission-errors';
import { FieldErrors } from '../../../shared/forms/field-errors';
import { FormErrors } from '../../../shared/forms/form-errors';

/**
 * Signing in as a Linux user of this machine (sshd checks the password), for Files and the
 * terminal. Submits through the page store's `signIn` (passed in), which rejects with the
 * server's error.
 */
@Component({
  selector: 'laris-linux-sign-in',
  imports: [
    FieldErrors,
    FormErrors,
    FormField,
    FormRoot,
    HlmButton,
    HlmCardImports,
    HlmFieldImports,
    HlmInput,
    PasswordToggle,
    TranslatePipe,
  ],
  templateUrl: './linux-sign-in.html',
})
export class LinuxSignIn {
  readonly submit = input.required<(request: LinuxSignInRequest) => Promise<void>>();
  /** Translation keys: what signing in opens. */
  readonly title = input.required<string>();
  readonly text = input.required<string>();

  protected readonly showPassword = signal(false);
  private readonly model = signal<LinuxSignInRequest>({ username: '', password: '' });
  protected readonly form = form(
    this.model,
    (path) => validateStandardSchema(path, linuxSignInRequestSchema),
    {
      submission: {
        action: async (tree) => {
          try {
            await this.submit()(tree().value());
          } catch (error) {
            return toSubmissionErrors(error, tree);
          }
          return undefined;
        },
      },
    },
  );
}
