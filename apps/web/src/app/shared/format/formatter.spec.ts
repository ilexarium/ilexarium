import { TestBed } from '@angular/core/testing';
import { LanguageService } from '../../core/i18n/language';
import { Formatter } from './formatter';

describe('Formatter', () => {
  it('formats in the current language', async () => {
    const format = TestBed.inject(Formatter);
    expect(format.bytes(3_400_000_000)).toBe('3.4 GB');
    await TestBed.inject(LanguageService).setLanguage('de');
    expect(format.bytes(3_400_000_000)).toBe('3,4 GB');
    expect(format.duration(3 * 86_400 + 4 * 3_600)).toBe('3 Tage, 4 Stunden');
  });

  it('keeps Latin digits in Arabic', async () => {
    const format = TestBed.inject(Formatter);
    await TestBed.inject(LanguageService).setLanguage('ar');
    for (const text of [
      format.bytes(1_234_000_000),
      format.percent(42),
      format.duration(3 * 86_400 + 4 * 3_600),
    ]) {
      expect(text, text).toMatch(/[0-9]/);
      expect(text, text).not.toMatch(/[٠-٩۰-۹]/); // Arabic-Indic digits
    }
  });
});
