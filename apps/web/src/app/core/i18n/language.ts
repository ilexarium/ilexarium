import { computed, DOCUMENT, effect, inject, Service, signal } from '@angular/core';
import {
  DEFAULT_LANGUAGE,
  isLanguage,
  type Language,
  preferredLanguage,
  RTL_LANGUAGES,
} from '@homelab/i18n';
import { TranslateService } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';
import { AVAILABLE_LANGUAGES } from './i18n-loader';

export const LANGUAGE_STORAGE_KEY = 'homelab.language';

/**
 * The interface language: remembered per browser (a device preference, like the theme — it stays
 * after sign-out); without a choice, the browser's language if there is a file for it, else
 * English. `<html lang dir>` follow it, so screen readers and the right-to-left layout do too.
 * English is always loaded as well: missing keys fall back to it.
 */
@Service()
export class LanguageService {
  private readonly translate = inject(TranslateService);
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
    await firstValueFrom(this.translate.setFallbackLang(DEFAULT_LANGUAGE));
    try {
      await firstValueFrom(this.translate.use(this.current()));
    } catch {
      // Its file didn't load (offline, a failed chunk): English, until chosen again.
      this.current.set(DEFAULT_LANGUAGE);
      await firstValueFrom(this.translate.use(DEFAULT_LANGUAGE));
    }
  }

  /** Switches once the language's file has loaded; remembered for this browser. */
  async setLanguage(language: Language): Promise<void> {
    await firstValueFrom(this.translate.use(language));
    this.current.set(language);
    try {
      this.window?.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    } catch {
      // Storage unavailable: the choice lasts until the page is reloaded.
    }
  }

  private initial(): Language {
    let stored: string | null = null;
    try {
      stored = this.window?.localStorage.getItem(LANGUAGE_STORAGE_KEY) ?? null;
    } catch {
      // Storage unavailable: no stored choice.
    }
    const choice = isLanguage(stored)
      ? stored
      : preferredLanguage(this.window?.navigator.languages ?? []);
    return AVAILABLE_LANGUAGES.includes(choice) ? choice : DEFAULT_LANGUAGE;
  }
}
