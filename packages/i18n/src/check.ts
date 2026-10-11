import type { Messages } from './i18n.model.js';
import { type PluralForm, pluralForms, splitPluralKey } from './plurals.js';

/** `{ logs: { title: 'Logs' } }` → `{ 'logs.title': 'Logs' }`. Throws on a non-string leaf. */
export function flattenMessages(messages: Messages, prefix = ''): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(messages)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') flat[path] = value;
    else if (value !== null && typeof value === 'object')
      Object.assign(flat, flattenMessages(value, path));
    else throw new Error(`${path}: not a string or an object`);
  }
  return flat;
}

/** The placeholder names in a message: `'{{ count }} of {{total}}'` → `['count', 'total']`. */
export function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((match) => match[1]))].sort();
}

/**
 * What's wrong with `translation` (in `language`) compared with the reference (`en.json`): missing
 * or extra keys, empty messages, placeholders that differ, plural forms the language needs but
 * lacks (or has but doesn't use). A plural form may leave out `{{count}}` (Arabic writes "one" and
 * "two" as words); every other placeholder must be there. Empty: all good.
 */
export function checkTranslations(
  reference: Messages,
  translation: Messages,
  language: string,
): string[] {
  const issues: string[] = [];
  const ref = group(flattenMessages(reference));
  const own = group(flattenMessages(translation));
  const forms = pluralForms(language);

  for (const [key, text] of ref.plain) {
    const value = own.plain.get(key);
    if (value === undefined) {
      issues.push(`${key}: missing`);
    } else {
      if (!value.trim()) issues.push(`${key}: empty`);
      const want = placeholders(text).join(', ');
      const have = placeholders(value).join(', ');
      if (want !== have) issues.push(`${key}: placeholders {${have}}, expected {${want}}`);
    }
  }
  for (const key of own.plain.keys()) {
    if (!ref.plain.has(key)) issues.push(`${key}: not in the reference`);
  }

  for (const [base, refForms] of ref.plural) {
    const ownForms = own.plural.get(base);
    if (!ownForms) {
      issues.push(`${base}: missing (plural)`);
      continue;
    }
    const allowed = new Set([...refForms.values()].flatMap(placeholders));
    const required = [...allowed].filter((name) => name !== 'count');
    for (const form of forms) {
      const value = ownForms.get(form);
      if (value === undefined) {
        issues.push(`${base}_${form}: missing (${language} needs it)`);
        continue;
      }
      if (!value.trim()) issues.push(`${base}_${form}: empty`);
      const names = placeholders(value);
      for (const name of names) {
        if (!allowed.has(name)) issues.push(`${base}_${form}: unknown placeholder {${name}}`);
      }
      for (const name of required) {
        if (!names.includes(name)) issues.push(`${base}_${form}: missing placeholder {${name}}`);
      }
    }
    for (const form of ownForms.keys()) {
      if (!forms.includes(form)) issues.push(`${base}_${form}: ${language} has no "${form}" form`);
    }
  }
  for (const base of own.plural.keys()) {
    if (!ref.plural.has(base)) issues.push(`${base}: not in the reference (plural)`);
  }
  return issues;
}

/** Plain keys, and plural keys grouped by their base. */
function group(flat: Record<string, string>) {
  const plain = new Map<string, string>();
  const plural = new Map<string, Map<PluralForm, string>>();
  for (const [key, value] of Object.entries(flat)) {
    const split = splitPluralKey(key);
    if (!split) {
      plain.set(key, value);
      continue;
    }
    const forms = plural.get(split.base) ?? new Map<PluralForm, string>();
    forms.set(split.form, value);
    plural.set(split.base, forms);
  }
  return { plain, plural };
}
