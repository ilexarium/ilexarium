/** The plural forms `Intl.PluralRules` can name — the suffixes of plural keys. */
export const PLURAL_FORMS = ['zero', 'one', 'two', 'few', 'many', 'other'] as const;
export type PluralForm = (typeof PLURAL_FORMS)[number];

/**
 * The key for `count` of a plural message: `pluralKey('logs.skipped', 3, 'en')` →
 * `'logs.skipped_other'`; in Arabic → `'logs.skipped_few'`. Each language file has one entry
 * per form its language uses.
 */
export function pluralKey(key: string, count: number, language: string): string {
  return `${key}_${new Intl.PluralRules(language).select(count)}`;
}

/** The plural forms a language uses: English `one, other`; Arabic all six. */
export function pluralForms(language: string): PluralForm[] {
  return new Intl.PluralRules(language).resolvedOptions().pluralCategories as PluralForm[];
}

/** `'logs.skipped_few'` → `{ base: 'logs.skipped', form: 'few' }`; null for other keys. */
export function splitPluralKey(key: string): { base: string; form: PluralForm } | null {
  const match = /^(.+)_(zero|one|two|few|many|other)$/.exec(key);
  return match ? { base: match[1], form: match[2] as PluralForm } : null;
}
