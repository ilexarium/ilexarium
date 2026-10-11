import type { Messages } from '@homelab/i18n';
import type { Language } from '@homelab/i18n';
import type { TranslateLoader, TranslationObject } from '@ngx-translate/core';
import { from, map, type Observable } from 'rxjs';

/**
 * The language files from `@homelab/i18n`, each its own lazy chunk — loaded only when that
 * language is used. A new language joins here with its file.
 */
const FILES: Partial<Record<Language, () => Promise<{ default: Messages }>>> = {
  en: () => import('@homelab/i18n/en.json'),
  de: () => import('@homelab/i18n/de.json'),
  ar: () => import('@homelab/i18n/ar.json'),
};

/** The languages there is a file for. */
export const AVAILABLE_LANGUAGES = Object.keys(FILES) as Language[];

export class I18nLoader implements TranslateLoader {
  getTranslation(language: string): Observable<TranslationObject> {
    const load = FILES[language as Language];
    if (!load) throw new Error(`No translations for "${language}"`);
    return from(load()).pipe(map((file) => file.default as TranslationObject));
  }
}
