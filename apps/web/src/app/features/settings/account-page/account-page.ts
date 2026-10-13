import { Component, inject, signal } from '@angular/core';
import { form, FormField, FormRoot, validateStandardSchema } from '@angular/forms/signals';
import { type ChangePasswordForm, changePasswordFormSchema } from '@homelab/shared';
import { HlmAlertImports } from '@ui/alert';
import { HlmButton } from '@ui/button';
import { HlmCardImports } from '@ui/card';
import { HlmFieldImports } from '@ui/field';
import { HlmInput } from '@ui/input';
import { AuthStore } from '../../../core/auth/auth-store';
import { PasswordToggle } from '../../../shared/forms/password-toggle';
import { toSubmissionErrors } from '../../../shared/forms/submission-errors';
import { TranslatePipe } from '@ngx-translate/core';
import { VALIDATION_LIMITS } from '@homelab/shared';
import { ErrorTextPipe } from '../../../shared/forms/error-text-pipe';
import { AccountPageStore } from './account-page-store';

const EMPTY: ChangePasswordForm = { currentPassword: '', newPassword: '', confirmNewPassword: '' };

@Component({
  selector: 'app-account-page',
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
  providers: [AccountPageStore],
  templateUrl: './account-page.html',
})
export class AccountPage {
  private readonly store = inject(AccountPageStore);
  protected readonly auth = inject(AuthStore);
  protected readonly showPasswords = signal(false);
  protected readonly limits = VALIDATION_LIMITS;

  private readonly model = signal<ChangePasswordForm>({ ...EMPTY });
  protected readonly form = form(
    this.model,
    (path) => validateStandardSchema(path, changePasswordFormSchema),
    {
      submission: {
        action: async (field) => {
          const { currentPassword, newPassword } = field().value();
          try {
            await this.store.changePassword({ currentPassword, newPassword });
          } catch (error) {
            return toSubmissionErrors(error, field);
          }
          this.form().reset({ ...EMPTY });
          this.showPasswords.set(false);
          return undefined;
        },
      },
    },
  );
}
