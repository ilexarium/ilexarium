import { Component, inject, signal, viewChild } from '@angular/core';
import { form, FormField, FormRoot, validateStandardSchema } from '@angular/forms/signals';
import {
  type LinuxSignInRequest,
  type TerminalTicketRequest,
  terminalTicketRequestSchema,
} from '@laris/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideX } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertImports } from '@ui/alert';
import { HlmButton } from '@ui/button';
import { HlmCardImports } from '@ui/card';
import { HlmFieldImports } from '@ui/field';
import { HlmInput } from '@ui/input';
import { HlmSkeleton } from '@ui/skeleton';
import { ThemeService } from '../../../core/theme/theme';
import { PasswordToggle } from '../../../shared/forms/password-toggle';
import { toSubmissionErrors } from '../../../shared/forms/submission-errors';
import { FieldErrors } from '../../../shared/forms/field-errors';
import { FormErrors } from '../../../shared/forms/form-errors';
import { LinuxSignIn } from '../linux-sign-in/linux-sign-in';
import { TerminalView } from '../terminal-view/terminal-view';
import type { TerminalSize } from '../terminal.model';
import { TerminalPageStore } from './terminal-page-store';

/**
 * The Terminal page (docs/plans/files_and_terminal.md, step 2): a shell of your Linux account in
 * the browser — the Linux sign-in, then the app password again for each terminal, then the
 * terminal; why it closed, and opening it again.
 */
@Component({
  selector: 'laris-terminal-page',
  imports: [
    FieldErrors,
    FormErrors,
    FormField,
    FormRoot,
    HlmAlertImports,
    HlmButton,
    HlmCardImports,
    HlmFieldImports,
    HlmInput,
    HlmSkeleton,
    LinuxSignIn,
    NgIcon,
    PasswordToggle,
    TerminalView,
    TranslatePipe,
  ],
  providers: [TerminalPageStore, provideIcons({ lucideX })],
  templateUrl: './terminal-page.html',
  host: { class: 'flex min-h-[calc(100dvh-7rem)] flex-col' },
})
export class TerminalPage {
  protected readonly store = inject(TerminalPageStore);
  protected readonly theme = inject(ThemeService);
  private readonly view = viewChild<TerminalView>('view');

  protected readonly signIn = (request: LinuxSignInRequest) => this.store.signIn(request);
  protected readonly showPassword = signal(false);
  private readonly model = signal<TerminalTicketRequest>({ password: '' });
  protected readonly unlockForm = form(
    this.model,
    (path) => validateStandardSchema(path, terminalTicketRequestSchema),
    {
      submission: {
        action: async (tree) => {
          try {
            await this.store.unlock(tree().value().password);
          } catch (error) {
            return toSubmissionErrors(error, tree);
          }
          tree().reset({ password: '' });
          return undefined;
        },
      },
    },
  );

  protected connect(size: TerminalSize): void {
    this.store.connect(size, (bytes) => this.view()?.write(bytes));
  }
}
