import en from '@homelab/i18n/en.json';
import {
  type MissingTranslationHandler,
  type MissingTranslationHandlerParams,
  provideMissingTranslationHandler,
  provideTranslateLoader,
  provideTranslateService,
  type TranslateLoader,
  type TranslationObject,
} from '@ngx-translate/core';
import { type Observable, of } from 'rxjs';

/** English, at once (no lazy chunk), so tests can assert the English text. */
class EnglishLoader implements TranslateLoader {
  getTranslation(): Observable<TranslationObject> {
    return of(en as TranslationObject);
  }
}

/** A key missing from en.json fails the test that renders it. */
class FailOnMissingTranslation implements MissingTranslationHandler {
  handle({ key }: MissingTranslationHandlerParams): string {
    throw new Error(`Missing translation in en.json: ${key}`);
  }
}

/** Translations for every test (`src/testing.ts`, the test builder's `providersFile`). */
export function provideTestTranslations() {
  return provideTranslateService({
    lang: 'en',
    fallbackLang: 'en',
    loader: provideTranslateLoader(EnglishLoader),
    missingTranslationHandler: provideMissingTranslationHandler(FailOnMissingTranslation),
  });
}
