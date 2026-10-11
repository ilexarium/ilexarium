import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkTranslations } from './check.js';
import type { Messages } from './i18n.model.js';
import { LANGUAGES } from './languages.js';

// The real language files, checked against en.json.

const file = (language: string) => new URL(`../messages/${language}.json`, import.meta.url);
const read = (language: string) => JSON.parse(readFileSync(file(language), 'utf8')) as Messages;

describe('language files', () => {
  const en = read('en');

  it('en.json is consistent in itself (plural forms, no empty messages)', () => {
    expect(checkTranslations(en, en, 'en')).toEqual([]);
  });

  // de.json and ar.json join as they are written (plan steps 5 and 6).
  for (const language of LANGUAGES.filter((l) => l !== 'en' && existsSync(file(l)))) {
    it(`${language}.json has every key, placeholder and plural form`, () => {
      expect(checkTranslations(en, read(language), language)).toEqual([]);
    });
  }
});
