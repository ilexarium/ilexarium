import { inject, Pipe, type PipeTransform } from '@angular/core';
import { Translator } from './translator';

/**
 * `{{ 'logs.skipped' | plural: count }}` — the language's plural form for `count`, with
 * `{{count}}` (and any other params) filled in. Not pure: it follows a language switch.
 */
@Pipe({ name: 'plural', pure: false })
export class PluralPipe implements PipeTransform {
  private readonly translator = inject(Translator);

  transform(key: string, count: number, params?: Record<string, unknown>): string {
    return this.translator.plural(key, count, params);
  }
}
