import { inject, Service } from '@angular/core';
import { pluralKey } from '@laris/i18n';
import { TranslateService } from '@ngx-translate/core';
import { LanguageService } from './language';
import { PLACEHOLDER_MARK } from './translator.constants';

/** For TypeScript; templates use the `translate` and `plural` pipes. */
@Service()
export class Translator {
  private readonly translateService = inject(TranslateService);
  private readonly languageService = inject(LanguageService);

  t(key: string, params?: Record<string, unknown>): string {
    this.languageService.language(); // tracked: re-run after a switch
    return this.translateService.instant(key, params) as string;
  }

  /** `plural('logs.skipped', 3)` → the language's form for 3 (`logs.skipped_other` in English). */
  plural(key: string, count: number, params?: Record<string, unknown>): string {
    return this.t(pluralKey(key, count, this.languageService.language()), { ...params, count });
  }

  /**
   * The text before and after a placeholder, for markup inside a translation: "Run {{command}} on
   * the server." → `['Run ', ' on the server.']`, and the template puts `<code>` between. The
   * placeholder may sit anywhere in each language; translations never contain HTML.
   */
  around(key: string, placeholder: string, params?: Record<string, unknown>): [string, string] {
    const text = this.t(key, { ...params, [placeholder]: PLACEHOLDER_MARK });
    const at = text.indexOf(PLACEHOLDER_MARK);
    return at < 0 ? [text, ''] : [text.slice(0, at), text.slice(at + PLACEHOLDER_MARK.length)];
  }
}
