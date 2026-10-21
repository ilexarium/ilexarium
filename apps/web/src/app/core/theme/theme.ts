import { computed, DestroyRef, DOCUMENT, effect, inject, Service, signal } from '@angular/core';
import { THEME_COLORS } from './theme.constants';
import type { ThemeChoice } from './theme.model';

export const THEME_STORAGE_KEY = 'laris.theme';
const CHOICES: readonly ThemeChoice[] = ['light', 'dark', 'system'];
const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * Light or dark: the `dark` class on `<html>` switches the theme tokens in `styles.css` (and the
 * charts follow); the `theme-color` meta gives the browser bar the same background. Remembered per browser — a device preference, not user data, so it stays after
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
    effect(() => {
      const dark = this.dark();
      this.document.documentElement.classList.toggle('dark', dark);
      this.document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', dark ? THEME_COLORS.dark : THEME_COLORS.light);
    });
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
