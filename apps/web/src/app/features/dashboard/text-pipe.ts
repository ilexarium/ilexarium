import { inject, Pipe, type PipeTransform } from '@angular/core';
import { Translator } from '../../core/i18n/translator';
import type { Text } from './dashboard.model';

/**
 * `{{ unit.text | text }}` — a `Text` in the current language: its plural form when it has a
 * count, and params that are texts themselves ("the system disk") translated too. Not pure: it
 * follows a language switch.
 */
@Pipe({ name: 'text', pure: false })
export class TextPipe implements PipeTransform {
  private readonly translator = inject(Translator);

  transform(value: Text | string): string {
    if (typeof value === 'string') return value;
    const params = Object.fromEntries(
      Object.entries(value.params ?? {}).map(([name, param]) => [
        name,
        isText(param) ? this.transform(param) : param,
      ]),
    );
    return value.count === undefined
      ? this.translator.t(value.key, params)
      : this.translator.plural(value.key, value.count, params);
  }
}

function isText(value: unknown): value is Text {
  return typeof value === 'object' && value !== null && typeof (value as Text).key === 'string';
}
