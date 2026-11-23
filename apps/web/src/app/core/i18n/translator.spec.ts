import { firstValueFrom } from 'rxjs';
import { Component, computed } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import { ConnectionStatus } from '../../layout/connection-status/connection-status';
import { LanguageService } from './language';
import { PluralPipe } from './plural-pipe';
import { Translator } from './translator';

/** German test texts on top of the English ones the tests load. */
async function switchToGerman() {
  await firstValueFrom(TestBed.inject(LanguageService).setLanguage('de'));
  TestBed.inject(TranslateService).setTranslation(
    'de',
    {
      connection: { offline: 'Getrennt' },
      processes: {
        count_one: '{{count}} Prozess',
        count_other: '{{count}} Prozesse',
      },
    },
    true,
  );
}

describe('Translator', () => {
  it('translates with params, and picks the plural form for a count', () => {
    const translator = TestBed.inject(Translator);
    expect(translator.t('pages.logs', { name: 'web' })).toBe('Logs · web');
    expect(translator.plural('processes.count', 1)).toBe('1 process');
    expect(translator.plural('processes.count', 900)).toBe('900 processes');
  });

  it('cuts a translation around a placeholder, for markup in between', () => {
    const translator = TestBed.inject(Translator);
    expect(translator.around('auth.setup.setupCodeHelp', 'command')).toEqual([
      'Shown at the end of installation. Lost it? Run ',
      ' on the server.',
    ]);
  });

  it('re-runs computed texts after a language switch', async () => {
    const translator = TestBed.inject(Translator);
    const label = TestBed.runInInjectionContext(() =>
      computed(() => translator.t('connection.offline')),
    );
    expect(label()).toBe('Offline');
    await switchToGerman();
    expect(label()).toBe('Getrennt');
  });

  it('uses each language’s own plural forms (Arabic has six)', async () => {
    await firstValueFrom(TestBed.inject(LanguageService).setLanguage('ar'));
    TestBed.inject(TranslateService).setTranslation(
      'ar',
      {
        x: {
          n_zero: 'zero',
          n_one: 'one',
          n_two: 'two',
          n_few: 'few {{count}}',
          n_many: 'many {{count}}',
          n_other: 'other {{count}}',
        },
      },
      true,
    );
    const translator = TestBed.inject(Translator);
    expect([0, 1, 2, 3, 11, 100].map((n) => translator.plural('x.n', n))).toEqual([
      'zero',
      'one',
      'two',
      'few 3',
      'many 11',
      'other 100',
    ]);
  });
});

@Component({
  imports: [PluralPipe, ConnectionStatus],
  template: `<p>{{ 'processes.count' | plural: 3 }}</p>
    <ilex-connection-status />`,
})
class Host {}

describe('templates', () => {
  it('re-render in the new language when it is switched', async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('3 processes');
    expect(el.textContent).toContain('Offline');

    await switchToGerman();
    await fixture.whenStable();
    expect(el.textContent).toContain('3 Prozesse');
    expect(el.textContent).toContain('Getrennt');
  });
});
