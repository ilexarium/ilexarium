import { inject, Service } from '@angular/core';
import { pluralKey } from '@homelab/i18n';
import { TranslateService } from '@ngx-translate/core';
import { LanguageService } from './language';

/** Marks where a placeholder sat, to cut a translation around it. */
const MARK = '\u0000';

/**
 * Translations for TypeScript (templates use the `translate` and `plural` pipes). Reads the
 * current language as a signal, so a `computed()` built on it follows a language switch.
 */
@Service()
export class Translator {
  private readonly translate = inject(TranslateService);
  private readonly language = inject(LanguageService);

  t(key: string, params?: Record<string, unknown>): string {
    this.language.language(); // tracked: re-run after a switch
    return this.translate.instant(key, params) as string;
  }

  /** `plural('logs.skipped', 3)` → the language's form for 3 (`logs.skipped_other` in English). */
  plural(key: string, count: number, params?: Record<string, unknown>): string {
    return this.t(pluralKey(key, count, this.language.language()), { ...params, count });
  }

  /**
   * The text before and after a placeholder, for markup inside a translation: "Run {{command}} on
   * the server." → `['Run ', ' on the server.']`, and the template puts `<code>` between. The
   * placeholder may sit anywhere in each language; translations never contain HTML.
   */
  around(key: string, placeholder: string, params?: Record<string, unknown>): [string, string] {
    const text = this.t(key, { ...params, [placeholder]: MARK });
    const at = text.indexOf(MARK);
    return at < 0 ? [text, ''] : [text.slice(0, at), text.slice(at + MARK.length)];
  }
}
