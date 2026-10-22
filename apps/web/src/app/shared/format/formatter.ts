import { inject, Service } from '@angular/core';
import { LanguageService } from '../../core/i18n/language';
import { Translator } from '../../core/i18n/translator';
import {
  formatBytes,
  formatClock,
  formatCount,
  formatDate,
  formatDateTime,
  formatDecimal,
  formatDuration,
  formatLogTime,
  formatPercent,
  formatRate,
} from './format';

/**
 * The `format.ts` functions in the current language, always with Latin digits (the owner's
 * decision: Arabic too shows 1,234, not ١٬٢٣٤ — `-u-nu-latn` makes it so in every browser). Reads
 * the language as a signal, so a `computed()` built on it follows a language switch.
 */
@Service()
export class Formatter {
  private readonly language = inject(LanguageService);
  private readonly translator = inject(Translator);

  bytes(bytes: number): string {
    return this.ltr(formatBytes(bytes, this.locale()));
  }

  rate(bytesPerSecond: number): string {
    return this.ltr(formatRate(bytesPerSecond, this.locale()));
  }

  count(count: number): string {
    return this.ltr(formatCount(count, this.locale()));
  }

  decimal(value: number, digits = 2): string {
    return this.ltr(formatDecimal(value, this.locale(), digits));
  }

  clock(at: number): string {
    return this.ltr(formatClock(at, this.locale()));
  }

  percent(percent: number): string {
    return this.ltr(formatPercent(percent, this.locale()));
  }

  duration(seconds: number): string {
    return formatDuration(seconds, this.locale(), this.translator.t('format.lessThanAMinute'));
  }

  /** The day of a moment ("member since"), in the current language. */
  date(at: string): string {
    return formatDate(at, this.locale());
  }

  /** Date and time of a moment (backups, restores), in the current language. */
  dateTime(at: string): string {
    return formatDateTime(at, this.locale());
  }

  /** How long ago a moment was, in words ("3 hours"); `now` passed in so it can follow a clock. */
  ago(at: string, now: number = Date.now()): string {
    return this.duration(Math.max(0, (now - Date.parse(at)) / 1000));
  }

  /**
   * Machine text (a path, a container's name) inside a translated sentence, kept left to right:
   * without the isolate, Arabic text shows "/mnt/usb" as "mnt/usb/".
   */
  machine(text: string): string {
    return this.ltr(text);
  }

  /**
   * A number with its unit ("6.2 GB") kept left to right inside a right-to-left sentence: without
   * the isolate, Arabic text shows "GB 6.2". Only in right-to-left languages (left to right it
   * changes nothing).
   */
  private ltr(text: string): string {
    return this.language.dir() === 'rtl' ? `\u2066${text}\u2069` : text;
  }

  /** One fixed, sortable form in every language (machine text). */
  logTime(at: string): string {
    return formatLogTime(at);
  }

  /** The current language, with Latin digits. */
  private locale(): string {
    return `${this.language.language()}-u-nu-latn`;
  }
}
