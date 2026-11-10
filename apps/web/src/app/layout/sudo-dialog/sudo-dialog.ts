import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { form, FormField, FormRoot, validateStandardSchema } from '@angular/forms/signals';
import { type LinuxSudoRequest, linuxSudoRequestSchema } from '@ilex/shared';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import { HlmDialogImports } from '@ui/dialog';
import { HlmFieldImports } from '@ui/field';
import { HlmInput } from '@ui/input';
import { LinuxSessionStore } from '../../core/linux/linux-session-store';
import { Formatter } from '../../shared/format/formatter';
import { FieldErrors } from '../../shared/forms/field-errors';
import { FormErrors } from '../../shared/forms/form-errors';
import { PasswordToggle } from '../../shared/forms/password-toggle';
import { toSubmissionErrors } from '../../shared/forms/submission-errors';

/**
 * The Linux account's password for its sudo, asked while an action waits for it (any page's,
 * through `LinuxSessionStore.withSudo`); unlocked, the action carries on. sudo keeps it unlocked
 * for a while; the password isn't kept, not even in the form.
 */
@Component({
  selector: 'ilex-sudo-dialog',
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
  templateUrl: './sudo-dialog.html',
})
export class SudoDialog {
  protected readonly linuxSessionStore = inject(LinuxSessionStore);
  protected readonly showPassword = signal(false);
  private readonly formatter = inject(Formatter);
  /** Kept left to right inside a right-to-left sentence. */
  protected readonly account = computed(() =>
    this.formatter.machine(this.linuxSessionStore.session()?.username ?? ''),
  );

  private readonly model = signal<LinuxSudoRequest>({ password: '' });
  protected readonly form = form(
    this.model,
    (path) => validateStandardSchema(path, linuxSudoRequestSchema),
    {
      submission: {
        action: async (tree) => {
          try {
            await this.linuxSessionStore.unlockSudo(tree().value().password);
          } catch (error) {
            return toSubmissionErrors(error, tree);
          }
          return undefined;
        },
      },
    },
  );

  /** The prompt this dialog showed: a late "closed" of it must not cancel a newer one. */
  private shownId = 0;

  constructor() {
    // Empty each time it opens, and nothing typed stays after it closes.
    effect(() => {
      if (this.linuxSessionStore.sudoPrompt()) this.shownId = this.linuxSessionStore.sudoPromptId();
      untracked(() => {
        this.form().reset({ password: '' });
        this.showPassword.set(false);
      });
    });
  }

  /** Closed in any way (unlocked, Cancel, Escape, the X): a waiting action gets "no". */
  protected onClosed(): void {
    this.linuxSessionStore.cancelSudo(this.shownId);
  }
}
