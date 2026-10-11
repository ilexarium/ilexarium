import { Component, inject, signal } from '@angular/core';
import { form, FormField, FormRoot, validateStandardSchema } from '@angular/forms/signals';
import { ActivatedRoute, Router } from '@angular/router';
import { type LoginRequest, loginRequestSchema } from '@homelab/shared';
import { HlmAlertImports } from '@ui/alert';
import { HlmButton } from '@ui/button';
import { HlmFieldImports } from '@ui/field';
import { HlmInput } from '@ui/input';
import { AuthApi } from '../../../core/auth/auth-api';
import { AuthStore } from '../../../core/auth/auth-store';
import { safeReturnUrl } from '../../../core/auth/return-url';
import { InsecureContextNotice } from '../../../core/security/insecure-context-notice';
import { SECURE_CONTEXT } from '../../../core/security/secure-context';
import { PasswordToggle } from '../../../shared/forms/password-toggle';
import { toSubmissionErrors } from '../../../shared/forms/submission-errors';
import { AuthFrame } from '../auth-frame/auth-frame';

@Component({
  selector: 'app-login-page',
  imports: [
    AuthFrame,
    FormField,
    FormRoot,
    HlmAlertImports,
    HlmButton,
    HlmFieldImports,
    HlmInput,
    InsecureContextNotice,
    PasswordToggle,
  ],
  templateUrl: './login-page.html',
})
export class LoginPage {
  private readonly api = inject(AuthApi);
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);
  private readonly query = inject(ActivatedRoute).snapshot.queryParamMap;

  protected readonly secure = inject(SECURE_CONTEXT);
  protected readonly expired = this.query.get('reason') === 'expired';
  protected readonly showPassword = signal(false);

  private readonly model = signal<LoginRequest>({ username: '', password: '' });
  protected readonly form = form(
    this.model,
    (path) => validateStandardSchema(path, loginRequestSchema),
    {
      submission: {
        action: async (field) => {
          try {
            const { user } = await this.api.login(field().value());
            this.auth.signedIn(user);
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
