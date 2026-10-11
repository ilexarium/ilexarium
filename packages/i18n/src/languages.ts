/** The languages the app is translated into; `en` is the reference and the fallback. */
export const LANGUAGES = ['en', 'de', 'ar'] as const;
export type Language = (typeof LANGUAGES)[number];

export const DEFAULT_LANGUAGE: Language = 'en';

/** Written right to left: the layout mirrors (`<html dir="rtl">`). */
export const RTL_LANGUAGES: readonly Language[] = ['ar'];

/** Each language's name in itself, for the language switch. */
export const LANGUAGE_NAMES: Record<Language, string> = {
  en: 'English',
  de: 'Deutsch',
  ar: 'العربية',
};

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}

/**
 * The first of the browser's preferred languages we have (`de-AT` counts as `de`), else English.
 * Pass `navigator.languages`.
 */
export function preferredLanguage(preferences: readonly string[]): Language {
  for (const preference of preferences) {
    const base = preference.toLowerCase().split('-')[0];
    if (isLanguage(base)) return base;
  }
  return DEFAULT_LANGUAGE;
}
