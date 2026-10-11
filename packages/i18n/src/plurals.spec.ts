import { describe, expect, it } from 'vitest';
import { pluralForms, pluralKey, splitPluralKey } from './plurals.js';

describe('plurals', () => {
  it('picks the key for a count by the language’s plural rules', () => {
    expect([0, 1, 2, 5].map((n) => pluralKey('logs.skipped', n, 'en'))).toEqual([
      'logs.skipped_other',
      'logs.skipped_one',
      'logs.skipped_other',
      'logs.skipped_other',
    ]);
    expect([0, 1, 2, 3, 11, 100].map((n) => pluralKey('x', n, 'ar'))).toEqual([
      'x_zero',
      'x_one',
      'x_two',
      'x_few',
      'x_many',
      'x_other',
    ]);
    expect(pluralKey('x', 1, 'de')).toBe('x_one');
  });

  it('lists the forms each language uses', () => {
    expect(pluralForms('en')).toEqual(['one', 'other']);
    expect(pluralForms('de')).toEqual(['one', 'other']);
    expect(new Set(pluralForms('ar'))).toEqual(
      new Set(['zero', 'one', 'two', 'few', 'many', 'other']),
    );
  });

  it('splits a plural key into its base and form', () => {
    expect(splitPluralKey('logs.skipped_few')).toEqual({ base: 'logs.skipped', form: 'few' });
    expect(splitPluralKey('logs.skipped')).toBeNull();
    expect(splitPluralKey('logs.some_thing')).toBeNull();
  });
});
