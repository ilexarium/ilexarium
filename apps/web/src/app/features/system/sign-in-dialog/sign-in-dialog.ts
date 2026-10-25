import {
  afterNextRender,
  Component,
  computed,
  effect,
  type ElementRef,
  Injector,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { form, FormField, FormRoot, validateStandardSchema } from '@angular/forms/signals';
import {
  FILES_ERROR_CODES,
  type LinuxSignInRequest,
  linuxSignInRequestSchema,
  type TerminalTicketRequest,
  terminalTicketRequestSchema,
} from '@laris/shared';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertImports } from '@ui/alert';
import { HlmButton } from '@ui/button';
import { HlmDialogImports } from '@ui/dialog';
import { HlmFieldImports } from '@ui/field';
import { HlmInput } from '@ui/input';
import { PasswordToggle } from '../../../shared/forms/password-toggle';
import { apiErrorCode, toSubmissionErrors } from '../../../shared/forms/submission-errors';
import { FieldErrors } from '../../../shared/forms/field-errors';
import { FormErrors } from '../../../shared/forms/form-errors';
import type { SignInStep } from './sign-in-dialog.model';

/**
 * Signing in as a Linux user of this machine (sshd checks the password), for Files and the
 * terminal; with `unlock` (the terminal), the app password next, in the same dialog. Submits
 * through the page store's methods (passed in), which reject with the server's error. The step is
 * the parent's: a Linux session that ends while the app password is asked brings back the first.
 */
@Component({
  selector: 'laris-sign-in-dialog',
  imports: [
    FieldErrors,
    FormErrors,
    FormField,
    FormRoot,
    HlmAlertImports,
    HlmButton,
    HlmDialogImports,
    HlmFieldImports,
    HlmInput,
    PasswordToggle,
    TranslatePipe,
  ],
  templateUrl: './sign-in-dialog.html',
})
export class SignInDialog {
  readonly open = input(false);
  /** The parent's: the app password once there is a Linux session. */
  readonly step = input<SignInStep>('linux');
  /** Translation key: why the Linux account is asked (again), above its fields. */
  readonly notice = input<string | null>(null);
  /** Translation keys: what signing in opens. */
  readonly title = input.required<string>();
  readonly text = input.required<string>();
  readonly signIn = input.required<(request: LinuxSignInRequest) => Promise<void>>();
  readonly unlock = input<(password: string) => Promise<void>>();
  /** Closed in any way (done, Cancel, Escape, the X): the parent sets `open` back. */
  readonly closed = output<void>();
  protected readonly shown = linkedSignal(() => this.open());

  private readonly injector = inject(Injector);
  private readonly linuxUsername = viewChild<ElementRef<HTMLInputElement>>('linuxUsername');
  private readonly appPassword = viewChild<ElementRef<HTMLInputElement>>('appPassword');
  protected readonly showPassword = signal(false);

  private readonly linuxModel = signal<LinuxSignInRequest>({ username: '', password: '' });
  protected readonly linuxForm = form(
    this.linuxModel,
    (path) => validateStandardSchema(path, linuxSignInRequestSchema),
    {
      submission: {
        action: async (tree) => {
          try {
            await this.signIn()(tree().value());
          } catch (error) {
            return toSubmissionErrors(error, tree);
          }
          // The Linux password isn't kept, not even in the form.
          tree().reset({ username: '', password: '' });
          this.showPassword.set(false);
          if (!this.unlock()) this.shown.set(false);
          return undefined;
        },
      },
    },
  );

  private readonly appModel = signal<TerminalTicketRequest>({ password: '' });
  protected readonly appForm = form(
    this.appModel,
    (path) => validateStandardSchema(path, terminalTicketRequestSchema),
    {
      submission: {
        action: async (tree) => {
          try {
            await this.unlock()!(tree().value().password);
          } catch (error) {
            if (apiErrorCode(error) !== FILES_ERROR_CODES.linuxSessionRequired) {
              return toSubmissionErrors(error, tree);
            }
            // The parent goes back to the Linux step, which says why.
            tree().reset({ password: '' });
            return undefined;
          }
          tree().reset({ password: '' });
          this.showPassword.set(false);
          this.shown.set(false);
          return undefined;
        },
      },
    },
  );

  protected readonly submitting = computed(
    () => this.linuxForm().submitting() || this.appForm().submitting(),
  );

  constructor() {
    // A step changed while open: the other step's fields are gone, and focus would fall out of
    // the dialog. The first run only notes the parent's step (opening focuses the first field).
    let lastStep: SignInStep | undefined;
    effect(() => {
      const step = this.step();
      const changed = lastStep !== undefined && step !== lastStep;
      lastStep = step;
      if (!changed || !untracked(this.shown)) return;
      afterNextRender(
        () => (step === 'app' ? this.appPassword() : this.linuxUsername())?.nativeElement.focus(),
        { injector: this.injector },
      );
    });
  }

  /** Closed in any way: nothing typed stays behind (passwords, errors). */
  protected onClosed(): void {
    this.linuxForm().reset({ username: '', password: '' });
    this.appForm().reset({ password: '' });
    this.showPassword.set(false);
    this.closed.emit();
  }
}
