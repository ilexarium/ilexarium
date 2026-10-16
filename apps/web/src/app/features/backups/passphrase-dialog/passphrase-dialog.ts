import { Component, inject, signal, viewChild } from '@angular/core';
import { form, FormField, FormRoot, validateStandardSchema } from '@angular/forms/signals';
import { type BackupPassphraseRequest, backupPassphraseRequestSchema } from '@homelab/shared';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertImports } from '@ui/alert';
import { HlmAlertDialog, HlmAlertDialogImports } from '@ui/alert-dialog';
import { HlmButton } from '@ui/button';
import { HlmFieldImports } from '@ui/field';
import { HlmInput } from '@ui/input';
import { ErrorTextPipe } from '../../../shared/forms/error-text-pipe';
import { PasswordToggle } from '../../../shared/forms/password-toggle';
import { toSubmissionErrors } from '../../../shared/forms/submission-errors';
import { BackupsPageStore } from '../backups-page/backups-page-store';

/**
 * "Show the passphrase again": the app password first (checked by the server, throttled like
 * sign-in; audited). On success the page shows the passphrase card. Submits through the page store.
 */
@Component({
  selector: 'app-passphrase-dialog',
  imports: [
    ErrorTextPipe,
    FormField,
    FormRoot,
    HlmAlertDialogImports,
    HlmAlertImports,
    HlmButton,
    HlmFieldImports,
    HlmInput,
    PasswordToggle,
    TranslatePipe,
  ],
  templateUrl: './passphrase-dialog.html',
})
export class PassphraseDialog {
  private readonly store = inject(BackupsPageStore);
  private readonly dialog = viewChild.required(HlmAlertDialog);
  protected readonly showPassword = signal(false);

  private readonly model = signal<BackupPassphraseRequest>({ password: '' });
  protected readonly form = form(
    this.model,
    (path) => validateStandardSchema(path, backupPassphraseRequestSchema),
    {
      submission: {
        action: async (tree) => {
          try {
            await this.store.showPassphrase(tree().value().password);
          } catch (error) {
            return toSubmissionErrors(error, tree);
          }
          this.close();
          return undefined;
        },
      },
    },
  );

  open(): void {
    this.form().reset({ password: '' });
    this.showPassword.set(false);
    this.dialog().open();
  }

  protected close(): void {
    this.form().reset({ password: '' });
    this.dialog().close();
  }
}
