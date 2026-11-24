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
import { type ChangePasswordForm, changePasswordFormSchema, VALIDATION_LIMITS } from '@ilex/shared';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import { HlmDialogImports } from '@ui/dialog';
import { HlmFieldImports } from '@ui/field';
import { HlmInput } from '@ui/input';
import { AuthStore } from '../../../core/auth/auth-store';
import { PasswordToggle } from '../../../shared/forms/password-toggle';
import { serverFormErrors, validateServerErrors } from '../../../shared/forms/submission-errors';
import { FieldErrors } from '../../../shared/forms/field-errors';
import { FormErrors } from '../../../shared/forms/form-errors';
import { ProfilePageStore } from '../profile-page/profile-page-store';

const EMPTY: ChangePasswordForm = { currentPassword: '', newPassword: '', confirmNewPassword: '' };

/**
 * Changing the password, from the profile page: the current one, then the new one twice. Saved
 * through the page's store; empty again each time it opens.
 */
@Component({
  selector: 'ilex-password-dialog',
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

  protected readonly profilePageStore = inject(ProfilePageStore);
  protected readonly authStore = inject(AuthStore);
  protected readonly showPasswords = signal(false);
  protected readonly limits = VALIDATION_LIMITS;

  private readonly model = signal<ChangePasswordForm>({ ...EMPTY });
  protected readonly form = form(
    this.model,
    (path) => {
      validateStandardSchema(path, changePasswordFormSchema);
      validateServerErrors(path, this.profilePageStore);
    },
    {
      submission: {
        // Only starts the store's submission; its errors come back through the validator above.
        action: (field) => {
          this.profilePageStore.changePassword(field().value());
          return Promise.resolve(undefined);
        },
      },
    },
  );

  protected readonly serverErrors = serverFormErrors(this.form, this.profilePageStore);

  constructor() {
    effect(() => {
      // Closed or opened again: nothing of the last submission stays, nor its passwords.
      if (!this.open()) {
        untracked(() => this.profilePageStore.resetSubmission());
        return;
      }
      untracked(() => {
        this.form().reset({ ...EMPTY });
        this.profilePageStore.resetSubmission();
        this.showPasswords.set(false);
      });
    });
    effect(() => {
      if (this.profilePageStore.saved()) untracked(() => this.shown.set(false));
    });
  }
}
