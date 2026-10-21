import {
  Component,
  effect,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  untracked,
} from '@angular/core';
import { form, FormField, FormRoot, validateStandardSchema } from '@angular/forms/signals';
import {
  type ChangePasswordForm,
  changePasswordFormSchema,
  VALIDATION_LIMITS,
} from '@laris/shared';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import { HlmDialogImports } from '@ui/dialog';
import { HlmFieldImports } from '@ui/field';
import { HlmInput } from '@ui/input';
import { AuthStore } from '../../../core/auth/auth-store';
import { PasswordToggle } from '../../../shared/forms/password-toggle';
import { toSubmissionErrors } from '../../../shared/forms/submission-errors';
import { FieldErrors } from '../../../shared/forms/field-errors';
import { FormErrors } from '../../../shared/forms/form-errors';
import { ProfilePageStore } from '../profile-page/profile-page-store';

const EMPTY: ChangePasswordForm = { currentPassword: '', newPassword: '', confirmNewPassword: '' };

/**
 * Changing the password, from the profile page: the current one, then the new one twice. Saved
 * through the page's store; empty again each time it opens.
 */
@Component({
  selector: 'laris-password-dialog',
  imports: [
    FieldErrors,
    FormErrors,
    FormField,
    FormRoot,
    HlmButton,
    HlmDialogImports,
    HlmFieldImports,
    HlmInput,
    PasswordToggle,
    TranslatePipe,
  ],
  templateUrl: './password-dialog.html',
})
export class PasswordDialog {
  readonly open = input(false);
  /** Closed in any way (changed, Cancel, Escape, the X): the parent sets `open` back. */
  readonly closed = output<void>();
  /** Follows `open`; set false here to close (the dialog then says `closed` once). */
  protected readonly shown = linkedSignal(() => this.open());

  private readonly store = inject(ProfilePageStore);
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
          this.shown.set(false);
          return undefined;
        },
      },
    },
  );

  constructor() {
    effect(() => {
      if (!this.open()) return;
      untracked(() => {
        this.form().reset({ ...EMPTY });
        this.showPasswords.set(false);
      });
    });
  }
}
