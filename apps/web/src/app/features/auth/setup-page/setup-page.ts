import { Component, computed, DOCUMENT, inject, signal } from '@angular/core';
import { form, FormField, FormRoot, validateStandardSchema } from '@angular/forms/signals';
import { Router } from '@angular/router';
import { type SetupForm, setupFormSchema } from '@homelab/shared';
import { HlmAlertImports } from '@ui/alert';
import { HlmButton } from '@ui/button';
import { HlmFieldImports } from '@ui/field';
import { HlmInput } from '@ui/input';
import { AuthApi } from '../../../core/auth/auth-api';
import { AuthStore } from '../../../core/auth/auth-store';
import { InsecureContextNotice } from '../../../core/security/insecure-context-notice';
import { SECURE_CONTEXT } from '../../../core/security/secure-context';
import { PasswordToggle } from '../../../shared/forms/password-toggle';
import { toSubmissionErrors } from '../../../shared/forms/submission-errors';
import { AuthFrame } from '../auth-frame/auth-frame';
import { TranslatePipe } from '@ngx-translate/core';
import { VALIDATION_LIMITS } from '@homelab/shared';
import { Translator } from '../../../core/i18n/translator';
import { APP_NAME } from '../../../core/page-title/page-title';
import { ErrorTextPipe } from '../../../shared/forms/error-text-pipe';

/**
 * Reads the setup code from the installer's link (`/setup#token=…`) and removes it from the
 * address bar at once, so it doesn't linger in the visible URL. The fragment never reaches a server.
 */
function takeTokenFromFragment(document: Document): string {
  const token = new URLSearchParams(document.location.hash.slice(1)).get('token') ?? '';
  if (document.location.hash) {
    const { pathname, search } = document.location;
    document.defaultView?.history.replaceState(
      document.defaultView.history.state,
      '',
      pathname + search,
    );
  }
  return token;
}

@Component({
  selector: 'app-setup-page',
  imports: [
    AuthFrame,
    ErrorTextPipe,
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
  templateUrl: './setup-page.html',
})
export class SetupPage {
  private readonly api = inject(AuthApi);
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);

  protected readonly secure = inject(SECURE_CONTEXT);
  protected readonly showPasswords = signal(false);
  protected readonly appName = APP_NAME;
  protected readonly limits = VALIDATION_LIMITS;
  private readonly translator = inject(Translator);
  /** Around the command, which the template shows as code. */
  protected readonly setupCodeHelp = computed(() =>
    this.translator.around('auth.setup.setupCodeHelp', 'command'),
  );

  private readonly model = signal<SetupForm>({
    setupToken: takeTokenFromFragment(inject(DOCUMENT)),
    username: '',
    password: '',
    confirmPassword: '',
  });
  protected readonly form = form(
    this.model,
    (path) => validateStandardSchema(path, setupFormSchema),
    {
      submission: {
        action: async (field) => {
          const { setupToken, username, password } = field().value();
          try {
            const { user } = await this.api.setup({ setupToken, username, password });
            this.auth.signedIn(user);
            await this.router.navigateByUrl('/');
            return undefined;
          } catch (error) {
            return toSubmissionErrors(error, field);
          }
        },
      },
    },
  );
}
