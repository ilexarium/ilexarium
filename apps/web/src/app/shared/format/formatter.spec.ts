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

  it('keeps a number with its unit left to right inside Arabic sentences ("6.2 GB", not "GB 6.2")', async () => {
    const format = TestBed.inject(Formatter);
    expect(format.bytes(1_234_000_000)).not.toMatch(/[\u2066\u2069]/);
    await TestBed.inject(LanguageService).setLanguage('ar');
    expect(format.bytes(1_234_000_000)).toMatch(/^\u2066.*GB\u2069$/);
    expect(format.rate(1_200)).toMatch(/^\u2066.*\u2069$/);
    expect(format.percent(42)).toMatch(/^\u2066.*\u2069$/);
  });

  it('keeps machine text left to right inside Arabic sentences ("/mnt/usb", not "mnt/usb/")', async () => {
    const format = TestBed.inject(Formatter);
    expect(format.machine('/mnt/usb')).toBe('/mnt/usb');
    await TestBed.inject(LanguageService).setLanguage('ar');
    expect(format.machine('/mnt/usb')).toBe('\u2066/mnt/usb\u2069');
  });
});
