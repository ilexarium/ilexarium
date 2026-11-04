import { DOCUMENT, inject, Service, signal } from '@angular/core';

import { LOG_TIMESTAMPS_KEY, LOG_WRAP_KEY, PHONE_QUERY } from './log-preferences.constants';
import { readStored, writeStored } from '../../core/storage/browser-storage';

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
    const value = readStored(this.window, key);
    return value === 'true' ? true : value === 'false' ? false : null;
  }

  private store(key: string, value: boolean): void {
    writeStored(this.window, key, String(value));
  }
}
