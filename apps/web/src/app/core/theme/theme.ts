import { computed, DestroyRef, DOCUMENT, effect, inject, Service, signal } from '@angular/core';

/** `system` follows the device's light/dark setting, live. */
export type ThemeChoice = 'light' | 'dark' | 'system';

export const THEME_STORAGE_KEY = 'homelab.theme';
const CHOICES: readonly ThemeChoice[] = ['light', 'dark', 'system'];
const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * Light or dark: the `dark` class on `<html>` switches the theme tokens in `styles.css` (and the
 * charts follow). Remembered per browser — a device preference, not user data, so it stays after
 * sign-out. `public/theme-init.js` applies the same choice before the app starts.
 */
@Service()
export class ThemeService {
  private readonly document = inject(DOCUMENT);
  private readonly window = this.document.defaultView;
  private readonly media =
    typeof this.window?.matchMedia === 'function' ? this.window.matchMedia(DARK_QUERY) : null;

  private readonly systemDark = signal(this.media?.matches ?? false);
  private readonly current = signal<ThemeChoice>(this.stored());

  readonly choice = this.current.asReadonly();
  readonly dark = computed(
    () => this.current() === 'dark' || (this.current() === 'system' && this.systemDark()),
  );

  constructor() {
    const onSystemChange = (event: MediaQueryListEvent) => this.systemDark.set(event.matches);
    this.media?.addEventListener('change', onSystemChange);
    inject(DestroyRef).onDestroy(() => this.media?.removeEventListener('change', onSystemChange));
    effect(() => this.document.documentElement.classList.toggle('dark', this.dark()));
  }

  setChoice(choice: ThemeChoice): void {
    this.current.set(choice);
    try {
      this.window?.localStorage.setItem(THEME_STORAGE_KEY, choice);
    } catch {
      // Storage unavailable: the choice lasts until the page is reloaded.
    }
  }

  private stored(): ThemeChoice {
    try {
      const value = this.window?.localStorage.getItem(THEME_STORAGE_KEY);
      return CHOICES.find((choice) => choice === value) ?? 'system';
    } catch {
      return 'system';
    }
  }
}
