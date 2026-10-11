import { Component, inject, signal } from '@angular/core';
import { form, FormField, FormRoot, validateStandardSchema } from '@angular/forms/signals';
import { type ChangePasswordForm, changePasswordFormSchema } from '@homelab/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { HlmAlertImports } from '@ui/alert';
import { HlmButton } from '@ui/button';
import { HlmCardImports } from '@ui/card';
import { HlmFieldImports } from '@ui/field';
import { HlmInput } from '@ui/input';
import { AuthApi } from '../../../core/auth/auth-api';
import { AuthStore } from '../../../core/auth/auth-store';
import { PasswordToggle } from '../../../shared/forms/password-toggle';
import { toSubmissionErrors } from '../../../shared/forms/submission-errors';

const EMPTY: ChangePasswordForm = { currentPassword: '', newPassword: '', confirmNewPassword: '' };

@Component({
  selector: 'app-account-page',
  imports: [
    FormField,
    FormRoot,
    HlmAlertImports,
    HlmButton,
    HlmCardImports,
    HlmFieldImports,
    HlmInput,
    PasswordToggle,
  ],
  templateUrl: './account-page.html',
})
export class AccountPage {
  private readonly api = inject(AuthApi);
  protected readonly auth = inject(AuthStore);
  protected readonly showPasswords = signal(false);

  private readonly model = signal<ChangePasswordForm>({ ...EMPTY });
  protected readonly form = form(
    this.model,
    (path) => validateStandardSchema(path, changePasswordFormSchema),
    {
      submission: {
        action: async (field) => {
          const { currentPassword, newPassword } = field().value();
          try {
            await this.api.changePassword({ currentPassword, newPassword });
          } catch (error) {
            return toSubmissionErrors(error, field);
          }
          this.form().reset({ ...EMPTY });
          this.showPasswords.set(false);
          toast.success('Password changed', {
            description: 'Other devices were signed out.',
          });
          return undefined;
        },
      },
    },
  );
}
