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
import { type ProfileForm, profileFormSchema, VALIDATION_LIMITS } from '@homelab/shared';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import { HlmDialogImports } from '@ui/dialog';
import { HlmFieldImports } from '@ui/field';
import { HlmInput } from '@ui/input';
import { AuthStore } from '../../core/auth/auth-store';
import { toSubmissionErrors } from '../forms/submission-errors';
import { FieldErrors } from '../forms/field-errors';
import { FormErrors } from '../forms/form-errors';
import { AvatarPicker } from './avatar-picker/avatar-picker';
import { ProfileEditStore } from './profile-edit-store';

/**
 * Editing one's profile: the picture, the display name, the email address. Opened from the user
 * menu and from the profile page; starts from the saved profile each time it opens.
 */
@Component({
  selector: 'app-profile-dialog',
  imports: [
    AvatarPicker,
    FieldErrors,
    FormErrors,
    FormField,
    FormRoot,
    HlmButton,
    HlmDialogImports,
    HlmFieldImports,
    HlmInput,
    TranslatePipe,
  ],
  providers: [ProfileEditStore],
  templateUrl: './profile-dialog.html',
})
export class ProfileDialog {
  readonly open = input(false);
  /** Closed in any way (saved, Cancel, Escape, the X): the parent sets `open` back. */
  readonly closed = output<void>();
  /** Follows `open`; set false here to close (the dialog then says `closed` once). */
  protected readonly shown = linkedSignal(() => this.open());

  protected readonly auth = inject(AuthStore);
  protected readonly edit = inject(ProfileEditStore);
  protected readonly limits = VALIDATION_LIMITS;

  private readonly model = signal<ProfileForm>({ displayName: '', email: '' });
  protected readonly form = form(
    this.model,
    (path) => validateStandardSchema(path, profileFormSchema),
    {
      submission: {
        action: async (field) => {
          try {
            await this.edit.save(field().value());
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
        const user = this.auth.user();
        this.edit.reset();
        this.form().reset({ displayName: user?.displayName ?? '', email: user?.email ?? '' });
      });
    });
  }

  protected picture() {
    const picture = this.edit.picture();
    return picture.kind === 'set' ? picture.url : null;
  }
}
