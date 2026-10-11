import { inject, Pipe, type PipeTransform } from '@angular/core';
import type { ValidationError } from '@angular/forms/signals';
import { VALIDATION_LIMITS } from '@homelab/shared';
import { Translator } from '../../core/i18n/translator';
import type { FormError } from './forms.model';

/** Messages that are translation keys; anything else is a server's own text, shown as it is. */
const KEY = /^(validation|errors)\./;

/**
 * `{{ error | errorText }}` — a form error in the current language: the shared schemas' messages
 * and our error keys are translated (with the validation limits and the error's own `params`; a
 * `count` picks the plural form); a server's unknown text is shown as it is. Not pure: it follows
 * a language switch.
 */
@Pipe({ name: 'errorText', pure: false })
export class ErrorTextPipe implements PipeTransform {
  private readonly translator = inject(Translator);

  transform(error: ValidationError): string {
    const message = error.message ?? '';
    if (!KEY.test(message)) return message;
    const params: Record<string, string | number> = {
      ...VALIDATION_LIMITS,
      ...(error as FormError).params,
    };
    const count = params['count'];
    return typeof count === 'number'
      ? this.translator.plural(message, count, params)
      : this.translator.t(message, params);
  }
}
