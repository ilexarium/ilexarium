import { Component, computed, inject, Injector, input, type OnInit, signal } from '@angular/core';
import {
  type FieldTree,
  form,
  FormField,
  FormRoot,
  validateStandardSchema,
} from '@angular/forms/signals';
import {
  type AlertChannelsResponse,
  type EmailChannelForm,
  emailChannelFormSchema,
} from '@ilex/shared';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertImports } from '@ui/alert';
import { HlmButton } from '@ui/button';
import { HlmCardImports } from '@ui/card';
import { HlmFieldImports } from '@ui/field';
import { HlmInput } from '@ui/input';
import { Translator } from '../../../core/i18n/translator';
import { Formatter } from '../../../shared/format/formatter';
import { PasswordToggle } from '../../../shared/forms/password-toggle';
import { toSubmissionErrors } from '../../../shared/forms/submission-errors';
import { FieldErrors } from '../../../shared/forms/field-errors';
import { FormErrors } from '../../../shared/forms/form-errors';
import { NotificationsPageStore } from '../notifications-page/notifications-page-store';

/** Submission port when nothing is saved yet: STARTTLS. */
const DEFAULT_PORT = 587;

/**
 * The mail server's settings: switched on or off, server, port, login, sender and recipient. The
 * password never comes back from the server: "saved", and an empty field keeps it.
 */
@Component({
  selector: 'ilex-email-form',
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
    PasswordToggle,
    TranslatePipe,
  ],
  templateUrl: './email-form.html',
})
export class EmailForm implements OnInit {
  readonly settings = input.required<AlertChannelsResponse['email']>();

  /** The form submits through its page's store. */
  protected readonly notificationsPageStore = inject(NotificationsPageStore);
  private readonly injector = inject(Injector);
  private readonly translator = inject(Translator);
  private readonly formatter = inject(Formatter);
  protected readonly showPassword = signal(false);
  protected model!: ReturnType<typeof signal<EmailChannelForm>>;
  protected form!: FieldTree<EmailChannelForm>;

  protected readonly testing = computed(() =>
    this.notificationsPageStore.testing().includes('email'),
  );
  protected readonly lastFailure = computed(() => {
    const failure = this.settings()?.lastFailure;
    if (!failure) return null;
    return this.translator.t('notifications.lastFailure', {
      time: this.formatter.dateTime(failure.at),
      problem: this.translator.t(`alerts.problem.${failure.problem}`),
    });
  });

  ngOnInit(): void {
    const saved = this.settings();
    this.model = signal<EmailChannelForm>({
      enabled: saved?.enabled ?? true,
      host: saved?.host ?? '',
      port: saved?.port ?? DEFAULT_PORT,
      username: saved?.username ?? '',
      password: '',
      from: saved?.from ?? '',
      to: saved?.to ?? '',
    });
    this.form = form(this.model, (path) => validateStandardSchema(path, emailChannelFormSchema), {
      injector: this.injector,
      submission: {
        action: async (tree) => {
          const { password, ...rest } = tree().value();
          try {
            await this.notificationsPageStore.saveEmail({ ...rest, ...(password && { password }) });
          } catch (error) {
            return toSubmissionErrors(error, tree);
          }
          this.form.password().value.set('');
          this.showPassword.set(false);
          return undefined;
        },
      },
    });
  }
}
