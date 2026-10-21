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
  type NtfyChannelForm,
  ntfyChannelFormSchema,
} from '@homelab/shared';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertImports } from '@ui/alert';
import { HlmButton } from '@ui/button';
import { HlmCardImports } from '@ui/card';
import { HlmFieldImports } from '@ui/field';
import { HlmInput } from '@ui/input';
import { Translator } from '../../../core/i18n/translator';
import { Formatter } from '../../../shared/format/formatter';
import { toSubmissionErrors } from '../../../shared/forms/submission-errors';
import { FieldErrors } from '../../../shared/forms/field-errors';
import { FormErrors } from '../../../shared/forms/form-errors';
import { NotificationsPageStore } from '../notifications-page/notifications-page-store';

const TOPIC_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

/** A long random topic name to suggest: on ntfy.sh the name is the password. */
function randomTopic(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `laris-${Array.from(bytes, (b) => TOPIC_ALPHABET[b % TOPIC_ALPHABET.length]).join('')}`;
}

/**
 * ntfy's settings: switched on or off, the topic URL and an optional access token. Both are
 * secrets: they never come back from the server ("saved"), and empty fields keep them.
 */
@Component({
  selector: 'app-ntfy-form',
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
    TranslatePipe,
  ],
  templateUrl: './ntfy-form.html',
})
export class NtfyForm implements OnInit {
  readonly settings = input.required<AlertChannelsResponse['ntfy']>();

  /** The form submits through its page's store. */
  protected readonly store = inject(NotificationsPageStore);
  private readonly injector = inject(Injector);
  private readonly translator = inject(Translator);
  protected readonly format = inject(Formatter);
  protected readonly exampleUrl = `https://ntfy.sh/${randomTopic()}`;
  protected model!: ReturnType<typeof signal<NtfyChannelForm>>;
  protected form!: FieldTree<NtfyChannelForm>;

  protected readonly testing = computed(() => this.store.testing().includes('ntfy'));
  protected readonly plainHttp = computed(() =>
    this.model().topicUrl.trim().toLowerCase().startsWith('http://'),
  );
  protected readonly lastFailure = computed(() => {
    const failure = this.settings()?.lastFailure;
    if (!failure) return null;
    return this.translator.t('notifications.lastFailure', {
      time: this.format.dateTime(failure.at),
      problem: this.translator.t(`alerts.problem.${failure.problem}`),
    });
  });

  ngOnInit(): void {
    this.model = signal<NtfyChannelForm>({
      enabled: this.settings()?.enabled ?? true,
      topicUrl: '',
      token: '',
      clearToken: false,
    });
    this.form = form(this.model, (path) => validateStandardSchema(path, ntfyChannelFormSchema), {
      injector: this.injector,
      submission: {
        action: async (tree) => {
          const { enabled, topicUrl, token, clearToken } = tree().value();
          try {
            await this.store.saveNtfy({
              enabled,
              ...(topicUrl && { topicUrl }),
              ...(clearToken ? { token: null } : token ? { token } : {}),
            });
          } catch (error) {
            return toSubmissionErrors(error, tree);
          }
          this.form().reset({ enabled, topicUrl: '', token: '', clearToken: false });
          return undefined;
        },
      },
    });
  }
}
