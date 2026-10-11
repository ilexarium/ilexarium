import { inject, Service } from '@angular/core';
import { LanguageService } from '../../core/i18n/language';
import { Translator } from '../../core/i18n/translator';
import { formatBytes, formatDuration, formatLogTime, formatPercent, formatRate } from './format';

/**
 * The `format.ts` functions in the current language. Reads the language as a signal, so a
 * `computed()` built on it follows a language switch.
 */
@Service()
export class Formatter {
  private readonly language = inject(LanguageService);
  private readonly translator = inject(Translator);

  bytes(bytes: number): string {
    return formatBytes(bytes, this.language.language());
  }

  rate(bytesPerSecond: number): string {
    return formatRate(bytesPerSecond, this.language.language());
  }

  percent(percent: number): string {
    return formatPercent(percent, this.language.language());
  }

  duration(seconds: number): string {
    return formatDuration(
      seconds,
      this.language.language(),
      this.translator.t('format.lessThanAMinute'),
    );
  }

  /** Log times stay in one fixed, sortable form in every language (machine text). */
  logTime(at: string): string {
    return formatLogTime(at);
  }
}
