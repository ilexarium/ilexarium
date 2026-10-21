import { DOCUMENT, inject, Service, signal } from '@angular/core';

export const LOG_TIMESTAMPS_KEY = 'laris.logs.timestamps';
export const LOG_WRAP_KEY = 'laris.logs.wrap';
/** Below the `md` breakpoint, like the layout's phone sheet. */
const PHONE_QUERY = '(max-width: 767px)';

/**
 * The log view's toggles, remembered per browser — device preferences, not user data, so they
 * stay after sign-out (like the theme). Defaults: timestamps on; lines wrap on phones only.
 */
@Service()
export class LogPreferences {
  private readonly window = inject(DOCUMENT).defaultView;

  private readonly _timestamps = signal(this.stored(LOG_TIMESTAMPS_KEY) ?? true);
  private readonly _wrap = signal(this.stored(LOG_WRAP_KEY) ?? this.isPhone());

  readonly timestamps = this._timestamps.asReadonly();
  readonly wrap = this._wrap.asReadonly();

  setTimestamps(value: boolean): void {
    this._timestamps.set(value);
    this.store(LOG_TIMESTAMPS_KEY, value);
  }

  setWrap(value: boolean): void {
    this._wrap.set(value);
    this.store(LOG_WRAP_KEY, value);
  }

  private isPhone(): boolean {
    return typeof this.window?.matchMedia === 'function'
      ? this.window.matchMedia(PHONE_QUERY).matches
      : false;
  }

  private stored(key: string): boolean | null {
    try {
      const value = this.window?.localStorage.getItem(key);
      return value === 'true' ? true : value === 'false' ? false : null;
    } catch {
      return null;
    }
  }

  private store(key: string, value: boolean): void {
    try {
      this.window?.localStorage.setItem(key, String(value));
    } catch {
      // Storage unavailable: the choice lasts until the page is reloaded.
    }
  }
}
