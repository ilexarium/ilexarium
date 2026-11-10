import { computed, DOCUMENT, effect, inject, Service, signal } from '@angular/core';
import {
  DEFAULT_LANGUAGE,
  isLanguage,
  type Language,
  preferredLanguage,
  RTL_LANGUAGES,
} from '@ilex/i18n';
import { TranslateService } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';
import { AVAILABLE_LANGUAGES } from './i18n-loader';
import { readStored, writeStored } from '../storage/browser-storage';
import { LANGUAGE_STORAGE_KEY } from './language.constants';

/**
 * The stored choice, else the browser's language if there is a file for it, else English; English
 * is always loaded too, for missing keys. A device preference, like the theme: it stays after
 * sign-out. `<html lang dir>` follow it, so screen readers and the right-to-left layout do too.
 */
@Service()
export class LanguageService {
  private readonly translateService = inject(TranslateService);
  private readonly document = inject(DOCUMENT);
  private readonly window = this.document.defaultView;
  private readonly current = signal<Language>(this.initial());

  readonly language = this.current.asReadonly();
  readonly dir = computed(() => (RTL_LANGUAGES.includes(this.current()) ? 'rtl' : 'ltr'));
  readonly available = AVAILABLE_LANGUAGES;

  constructor() {
    effect(() => {
      const html = this.document.documentElement;
      html.lang = this.current();
      html.dir = this.dir();
    });
  }

  /** Before the app starts: English and the chosen language, so no key ever shows. */
  async init(): Promise<void> {
    await firstValueFrom(this.translateService.setFallbackLang(DEFAULT_LANGUAGE));
    try {
      await firstValueFrom(this.translateService.use(this.current()));
    } catch {
      // Its file didn't load (offline, a failed chunk): English, until chosen again.
      this.current.set(DEFAULT_LANGUAGE);
      await firstValueFrom(this.translateService.use(DEFAULT_LANGUAGE));
    }
  }

  /** Switches once the language's file has loaded; remembered for this browser. */
  async setLanguage(language: Language): Promise<void> {
    await firstValueFrom(this.translateService.use(language));
    this.current.set(language);
    writeStored(this.window, LANGUAGE_STORAGE_KEY, language);
  }

  private initial(): Language {
    const stored = readStored(this.window, LANGUAGE_STORAGE_KEY);
    const choice = isLanguage(stored)
      ? stored
      : preferredLanguage(this.window?.navigator.languages ?? []);
    return AVAILABLE_LANGUAGES.includes(choice) ? choice : DEFAULT_LANGUAGE;
  }
}
