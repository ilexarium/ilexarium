import { describe, expect, it } from 'vitest';
import { isLanguage, LANGUAGE_NAMES, LANGUAGES, preferredLanguage } from './languages.js';

describe('languages', () => {
  it('knows English, German and Arabic, each named in itself', () => {
    expect(LANGUAGES).toEqual(['en', 'de', 'ar']);
    expect(LANGUAGE_NAMES).toEqual({ en: 'English', de: 'Deutsch', ar: 'العربية' });
  });

  it('tells our languages from anything else', () => {
    for (const value of ['en', 'de', 'ar']) expect(isLanguage(value), value).toBe(true);
    for (const value of ['fr', 'EN', 'de-AT', '', null, 1]) expect(isLanguage(value)).toBe(false);
  });

  it('picks the first preferred language we have, regional variants included', () => {
    expect(preferredLanguage(['fr-FR', 'de-AT', 'en'])).toBe('de');
    expect(preferredLanguage(['ar-EG'])).toBe('ar');
    expect(preferredLanguage(['EN-us'])).toBe('en');
  });

  it('falls back to English', () => {
    expect(preferredLanguage(['fr', 'es'])).toBe('en');
    expect(preferredLanguage([])).toBe('en');
  });
});
