import de from '@homelab/i18n/de.json';
import en from '@homelab/i18n/en.json';
import { firstValueFrom } from 'rxjs';
import { AVAILABLE_LANGUAGES, I18nLoader } from './i18n-loader';

describe('I18nLoader', () => {
  it('loads a language file from @homelab/i18n', async () => {
    expect(await firstValueFrom(new I18nLoader().getTranslation('en'))).toEqual(en);
    expect(await firstValueFrom(new I18nLoader().getTranslation('de'))).toEqual(de);
  });

  it('refuses a language without a file', () => {
    expect(() => new I18nLoader().getTranslation('fr')).toThrow('No translations for "fr"');
  });

  it('offers the languages that have a file', () => {
    expect(AVAILABLE_LANGUAGES).toEqual(['en', 'de', 'ar']);
  });
});
