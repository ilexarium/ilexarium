import { TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import { stubLocalStorage } from '../../layout/testing';
import { LANGUAGE_STORAGE_KEY, LanguageService } from './language';

function stubBrowserLanguages(languages: string[]): () => void {
  const original = Object.getOwnPropertyDescriptor(Navigator.prototype, 'languages');
  Object.defineProperty(navigator, 'languages', { configurable: true, get: () => languages });
  return () => {
    delete (navigator as { languages?: unknown }).languages;
    if (original) Object.defineProperty(Navigator.prototype, 'languages', original);
  };
}

describe('LanguageService', () => {
  let storage: ReturnType<typeof stubLocalStorage>;
  let restoreLanguages: () => void = () => undefined;

  beforeEach(() => (storage = stubLocalStorage()));
  afterEach(() => {
    storage.restore();
    restoreLanguages();
    document.documentElement.lang = '';
    document.documentElement.dir = '';
  });

  function create(): LanguageService {
    const service = TestBed.inject(LanguageService);
    TestBed.tick();
    return service;
  }

  it('starts in English, and sets <html lang dir>', () => {
    const service = create();
    expect(service.language()).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('starts with the browser’s language if there is a file for it', () => {
    restoreLanguages = stubBrowserLanguages(['de-AT', 'en']);
    expect(create().language()).toBe('de');
  });

  it('falls back to English for a browser language without a file', () => {
    // ar.json joins in plan step 6.
    restoreLanguages = stubBrowserLanguages(['ar-EG']);
    expect(create().language()).toBe('en');
  });

  it('starts with the remembered choice, over the browser’s language', () => {
    storage.storage.setItem(LANGUAGE_STORAGE_KEY, 'de');
    restoreLanguages = stubBrowserLanguages(['en-US']);
    expect(create().language()).toBe('de');
  });

  it('ignores a stored value that isn’t one of our languages', () => {
    storage.storage.setItem(LANGUAGE_STORAGE_KEY, 'klingon');
    expect(create().language()).toBe('en');
  });

  it('loads English as the fallback, and the language, before the app starts', async () => {
    const service = create();
    const translate = TestBed.inject(TranslateService);
    await service.init();
    expect(translate.getFallbackLang()).toBe('en');
    expect(translate.currentLang()).toBe('en');
    expect(translate.instant('pages.dashboard')).toBe('Dashboard');
  });

  it('switches, remembers the choice, and lays out right to left for Arabic', async () => {
    const service = create();
    await service.setLanguage('ar');
    TestBed.tick();
    expect(service.language()).toBe('ar');
    expect(TestBed.inject(TranslateService).currentLang()).toBe('ar');
    expect(storage.storage.getItem(LANGUAGE_STORAGE_KEY)).toBe('ar');
    expect(service.dir()).toBe('rtl');
    expect(document.documentElement.lang).toBe('ar');
    expect(document.documentElement.dir).toBe('rtl');
  });

  it('works without storage (blocked or private mode)', async () => {
    storage.restore();
    storage = stubLocalStorage({ blocked: true });
    const service = create();
    await service.setLanguage('de');
    expect(service.language()).toBe('de');
  });
});
