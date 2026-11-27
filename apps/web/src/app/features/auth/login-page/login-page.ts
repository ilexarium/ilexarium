import { Component, DOCUMENT, inject, signal } from '@angular/core';
import { form, FormField, FormRoot, validateStandardSchema } from '@angular/forms/signals';
import { ActivatedRoute, Router } from '@angular/router';
import { type LoginRequest, loginRequestSchema } from '@ilex/shared';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertImports } from '@ui/alert';
import { HlmButton } from '@ui/button';
import { HlmFieldImports } from '@ui/field';
import { HlmInput } from '@ui/input';
import { safeReturnUrl } from '../../../core/auth/return-url';
import { RECOVERY_STORAGE_KEY } from '../../../core/backups/backups.constants';
import { readStored, writeStored } from '../../../core/storage/browser-storage';
import { InsecureContextNotice } from '../../../core/security/insecure-context-notice';
import { SECURE_CONTEXT } from '../../../core/security/secure-context';
import { PasswordToggle } from '../../../shared/forms/password-toggle';
import { toSubmissionErrors } from '../../../shared/forms/submission-errors';
import { FieldErrors } from '../../../shared/forms/field-errors';
import { FormErrors } from '../../../shared/forms/form-errors';
import { AuthFrame } from '../auth-frame/auth-frame';
import { LoginPageStore } from './login-page-store';

@Component({
  selector: 'ilex-login-page',
  imports: [
    AuthFrame,
    FieldErrors,
    FormErrors,
    FormField,
    FormRoot,
    HlmAlertImports,
    HlmButton,
    HlmFieldImports,
    HlmInput,
    InsecureContextNotice,
    PasswordToggle,
    TranslatePipe,
  ],
  providers: [LoginPageStore],
  templateUrl: './login-page.html',
})
export class LoginPage {
  private readonly store = inject(LoginPageStore);
  private readonly router = inject(Router);
  private readonly query = inject(ActivatedRoute).snapshot.queryParamMap;

  protected readonly secure = inject(SECURE_CONTEXT);
  private readonly window = inject(DOCUMENT).defaultView;
  protected readonly expired = this.query.get('reason') === 'expired';
  /** Ilexarium was just restored from the backup disk (started from this browser). */
  protected readonly restored = !!readStored(this.window, RECOVERY_STORAGE_KEY);
  protected readonly showPassword = signal(false);

  private readonly model = signal<LoginRequest>({ username: '', password: '' });
  protected readonly form = form(
    this.model,
    (path) => validateStandardSchema(path, loginRequestSchema),
    {
      submission: {
        action: async (field) => {
          try {
            await this.store.login(field().value());
            writeStored(this.window, RECOVERY_STORAGE_KEY, '');
            await this.router.navigateByUrl(safeReturnUrl(this.query.get('returnUrl')));
            return undefined;
          } catch (error) {
            return toSubmissionErrors(error, field);
          }
        },
      },
    },
  );
}
