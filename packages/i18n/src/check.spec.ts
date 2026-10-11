import { describe, expect, it } from 'vitest';
import { checkTranslations, flattenMessages, placeholders } from './check.js';

const en = {
  logs: {
    title: 'Logs of {{ name }}',
    skipped_one: '{{count}} line skipped',
    skipped_other: '{{count}} lines skipped',
    matches_one: '{{count}} of {{total}} line matches',
    matches_other: '{{count}} of {{total}} lines match',
  },
};

describe('flattenMessages', () => {
  it('turns nested keys into dotted ones', () => {
    expect(flattenMessages({ a: { b: 'x', c: { d: 'y' } }, e: 'z' })).toEqual({
      'a.b': 'x',
      'a.c.d': 'y',
      e: 'z',
    });
  });

  it('refuses anything but strings and objects', () => {
    expect(() => flattenMessages({ a: { b: 1 } } as never)).toThrow('a.b');
    expect(() => flattenMessages({ a: null } as never)).toThrow('a');
  });
});

describe('placeholders', () => {
  it('finds each name once, with or without spaces', () => {
    expect(placeholders('{{ count }} of {{total}}, {{count}}')).toEqual(['count', 'total']);
    expect(placeholders('none')).toEqual([]);
  });
});

describe('checkTranslations', () => {
  it('accepts the reference itself', () => {
    expect(checkTranslations(en, en, 'en')).toEqual([]);
  });

  it('accepts a complete German translation', () => {
    const de = {
      logs: {
        title: 'Logs von {{name}}',
        skipped_one: '{{count}} Zeile übersprungen',
        skipped_other: '{{count}} Zeilen übersprungen',
        matches_one: '{{count}} von {{total}} Zeile passt',
        matches_other: '{{count}} von {{total}} Zeilen passen',
      },
    };
    expect(checkTranslations(en, de, 'de')).toEqual([]);
  });

  it('wants every form Arabic uses — "one" and "two" may leave out the number', () => {
    const forms = (word: string) => ({
      skipped_zero: `لم يتم تخطي أي ${word}`,
      skipped_one: `تم تخطي ${word} واحد`,
      skipped_two: 'تم تخطي سطرين',
      skipped_few: 'تم تخطي {{count}} أسطر',
      skipped_many: 'تم تخطي {{count}} سطرًا',
      skipped_other: 'تم تخطي {{count}} سطر',
    });
    const matches = {
      matches_zero: 'لا يطابق أي سطر من {{total}}',
      matches_one: 'يطابق سطر واحد من {{total}}',
      matches_two: 'يطابق سطران من {{total}}',
      matches_few: 'تطابق {{count}} أسطر من {{total}}',
      matches_many: 'يطابق {{count}} سطرًا من {{total}}',
      matches_other: 'يطابق {{count}} سطر من {{total}}',
    };
    const ar = { logs: { title: 'سجلات {{name}}', ...forms('سطر'), ...matches } };
    expect(checkTranslations(en, ar, 'ar')).toEqual([]);

    const { skipped_few: _few, ...lacking } = ar.logs;
    expect(checkTranslations(en, { logs: lacking }, 'ar')).toEqual([
      'logs.skipped_few: missing (ar needs it)',
    ]);
  });

  it('reports missing, extra and empty keys', () => {
    const de = {
      logs: {
        skipped_one: '{{count}} Zeile übersprungen',
        skipped_other: ' ',
        matches_one: '{{count}} von {{total}}',
        matches_other: '{{count}} von {{total}}',
        extra: 'Zusatz',
      },
      other_one: 'x',
      other_other: 'y',
    };
    expect(checkTranslations(en, de, 'de')).toEqual([
      'logs.title: missing',
      'logs.extra: not in the reference',
      'logs.skipped_other: empty',
      'other: not in the reference (plural)',
    ]);
  });

  it('reports placeholders that differ', () => {
    const de = {
      logs: {
        title: 'Logs von {{container}}',
        skipped_one: '{{count}} Zeile übersprungen',
        skipped_other: '{{count}} Zeilen übersprungen {{wer}}',
        matches_one: '{{count}} passt',
        matches_other: '{{count}} von {{total}} passen',
      },
    };
    expect(checkTranslations(en, de, 'de')).toEqual([
      'logs.title: placeholders {container}, expected {name}',
      'logs.skipped_other: unknown placeholder {wer}',
      'logs.matches_one: missing placeholder {total}',
    ]);
  });

  it('reports plural forms a language doesn’t have, and a plural missing altogether', () => {
    const de = {
      logs: {
        title: 'Logs von {{name}}',
        skipped_one: '{{count}} Zeile',
        skipped_other: '{{count}} Zeilen',
        skipped_few: '{{count}} Zeilen',
      },
    };
    expect(checkTranslations(en, de, 'de')).toEqual([
      'logs.skipped_few: de has no "few" form',
      'logs.matches: missing (plural)',
    ]);
  });
});
