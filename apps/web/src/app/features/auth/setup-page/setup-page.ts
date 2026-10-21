import { Component, computed, DOCUMENT, inject, signal } from '@angular/core';
import { form, FormField, FormRoot, validateStandardSchema } from '@angular/forms/signals';
import { Router } from '@angular/router';
import { type SetupForm, setupFormSchema, VALIDATION_LIMITS } from '@laris/shared';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import { HlmFieldImports } from '@ui/field';
import { HlmInput } from '@ui/input';
import { InsecureContextNotice } from '../../../core/security/insecure-context-notice';
import { SECURE_CONTEXT } from '../../../core/security/secure-context';
import { PasswordToggle } from '../../../shared/forms/password-toggle';
import { toSubmissionErrors } from '../../../shared/forms/submission-errors';
import { FieldErrors } from '../../../shared/forms/field-errors';
import { FormErrors } from '../../../shared/forms/form-errors';
import { Translator } from '../../../core/i18n/translator';
import { APP_NAME } from '../../../core/page-title/page-title';
import { AuthFrame } from '../auth-frame/auth-frame';
import { SetupPageStore } from './setup-page-store';

/**
 * The installer's link carries the code (`/setup#token=…`; a fragment never reaches a server).
 * Removed from the address bar at once, so it doesn't linger there.
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
  selector: 'laris-setup-page',
  imports: [
    AuthFrame,
    FieldErrors,
    FormErrors,
    FormField,
    FormRoot,
    HlmButton,
    HlmFieldImports,
    HlmInput,
    InsecureContextNotice,
    PasswordToggle,
    TranslatePipe,
  ],
  providers: [SetupPageStore],
  templateUrl: './setup-page.html',
})
export class SetupPage {
  private readonly store = inject(SetupPageStore);
  private readonly router = inject(Router);

  protected readonly secure = inject(SECURE_CONTEXT);
  protected readonly showPasswords = signal(false);
  protected readonly appName = APP_NAME;
  protected readonly limits = VALIDATION_LIMITS;
  private readonly translator = inject(Translator);
  /** The text around the command, which the template shows as code. */
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
            await this.store.setup({ setupToken, username, password });
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
