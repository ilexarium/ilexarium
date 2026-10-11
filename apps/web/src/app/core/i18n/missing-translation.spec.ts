import type { TranslateService } from '@ngx-translate/core';
import { WarnOnMissingTranslation } from './missing-translation';

describe('WarnOnMissingTranslation', () => {
  it('shows the key, and warns during development', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = new WarnOnMissingTranslation().handle({
      key: 'pages.nope',
      translateService: {} as TranslateService,
    });
    expect(result).toBe('pages.nope');
    expect(warn).toHaveBeenCalledWith('Missing translation: pages.nope');
    warn.mockRestore();
  });
});

describe('in tests', () => {
  it('a key missing from en.json fails the test that uses it', async () => {
    const { TestBed } = await import('@angular/core/testing');
    const { TranslateService } = await import('@ngx-translate/core');
    expect(() => TestBed.inject(TranslateService).instant('pages.nope')).toThrow(
      'Missing translation in en.json: pages.nope',
    );
  });
});
