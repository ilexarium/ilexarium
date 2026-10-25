import { Component, inject, input, signal } from '@angular/core';
import { form, FormField, FormRoot, validateStandardSchema } from '@angular/forms/signals';
import { processSignalAsAdministratorRequestSchema } from '@laris/shared';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import { HlmDialogImports } from '@ui/dialog';
import { HlmFieldImports } from '@ui/field';
import { HlmInput } from '@ui/input';
import { Translator } from '../../../core/i18n/translator';
import { Formatter } from '../../../shared/format/formatter';
import { FieldErrors } from '../../../shared/forms/field-errors';
import { FormErrors } from '../../../shared/forms/form-errors';
import { PasswordToggle } from '../../../shared/forms/password-toggle';
import { toSubmissionErrors } from '../../../shared/forms/submission-errors';
import type { EndRequest } from '../processes.model';

const passwordSchema = processSignalAsAdministratorRequestSchema.pick({ password: true });

/**
 * Ending another's process through the Linux account's own sudo: confirmed with the account's
 * password, for this one action — never kept, not even in the form. Submits through the page
 * store's method (passed in), which rejects with the server's error (a wrong password shows here).
 */
@Component({
  selector: 'laris-administrator-dialog',
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
  templateUrl: './administrator-dialog.html',
})
export class AdministratorDialog {
  readonly endAsAdministrator =
    input.required<(request: EndRequest, password: string) => Promise<void>>();
  /** The Linux account whose sudo is asked (named in the dialog). */
  readonly linuxUser = input<string | null>(null);

  private readonly translator = inject(Translator);
  private readonly formatter = inject(Formatter);
  protected readonly request = signal<EndRequest | null>(null);
  protected readonly shown = signal(false);
  protected readonly showPassword = signal(false);

  private readonly model = signal({ password: '' });
  protected readonly form = form(
    this.model,
    (path) => validateStandardSchema(path, passwordSchema),
    {
      submission: {
        action: async (tree) => {
          const request = this.request();
          if (!request) return undefined;
          try {
            await this.endAsAdministrator()(request, tree().value().password);
          } catch (error) {
            return toSubmissionErrors(error, tree);
          }
          this.shown.set(false);
          return undefined;
        },
      },
    },
  );

  open(request: EndRequest): void {
    this.request.set(request);
    this.shown.set(true);
  }

  protected user(request: EndRequest): string {
    return this.formatter.machine(
      request.process.user ??
        this.translator.t('processes.unknownUser', { uid: request.process.uid }),
    );
  }

  /** Closed in any way: the password goes with it. */
  protected onClosed(): void {
    this.form().reset({ password: '' });
    this.showPassword.set(false);
    this.shown.set(false);
  }
}
