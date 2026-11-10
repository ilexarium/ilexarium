import { flattenMessages, LANGUAGES, placeholders } from '@ilex/i18n';
import en from '@ilex/i18n/en.json' with { type: 'json' };
import { describe, expect, it } from 'vitest';
import { USER_LANGUAGES, VALIDATION_LIMITS } from './auth.js';
import { PROFILE_LIMITS, profileFormSchema, profileUpdateSchema } from './profile.js';

describe('USER_LANGUAGES', () => {
  it('are the languages the app is translated into', () => {
    expect([...USER_LANGUAGES]).toEqual([...LANGUAGES]);
  });
});

describe('profileFormSchema', () => {
  it('accepts a name and an address, trimmed', () => {
    expect(
      profileFormSchema.parse({ displayName: '  Anna Berg ', email: ' anna@example.com ' }),
    ).toEqual({ displayName: 'Anna Berg', email: 'anna@example.com' });
  });

  it('accepts empty fields: no name, no address', () => {
    expect(profileFormSchema.safeParse({ displayName: '', email: '  ' }).success).toBe(true);
  });

  it('accepts names in any script, up to the limit', () => {
    for (const displayName of [
      'أنا',
      'Jürgen Müller',
      '王小明',
      'x'.repeat(PROFILE_LIMITS.displayNameMax),
    ]) {
      expect(profileFormSchema.safeParse({ displayName, email: '' }).success, displayName).toBe(
        true,
      );
    }
  });

  it('refuses a name or address over its limit', () => {
    const long = { displayName: 'x'.repeat(PROFILE_LIMITS.displayNameMax + 1), email: '' };
    expect(profileFormSchema.safeParse(long).success).toBe(false);
    const email = `${'a'.repeat(PROFILE_LIMITS.emailMax)}@example.com`;
    expect(profileFormSchema.safeParse({ displayName: '', email }).success).toBe(false);
  });

  it('refuses something that isn’t an email address', () => {
    for (const email of ['anna', 'anna@', '@example.com', 'an na@example.com']) {
      expect(profileFormSchema.safeParse({ displayName: '', email }).success, email).toBe(false);
    }
  });

  it('refuses unknown fields', () => {
    const extra = { displayName: '', email: '', username: 'root' };
    expect(profileFormSchema.safeParse(extra).success).toBe(false);
  });
});

describe('profileUpdateSchema', () => {
  it('accepts any one field', () => {
    for (const update of [{ displayName: 'Anna' }, { email: '' }, { language: 'ar' }]) {
      expect(profileUpdateSchema.safeParse(update).success, JSON.stringify(update)).toBe(true);
    }
  });

  it('refuses an empty update, an unknown language and unknown fields', () => {
    for (const update of [{}, { language: 'fr' }, { language: null }, { avatar: 'x' }]) {
      expect(profileUpdateSchema.safeParse(update).success, JSON.stringify(update)).toBe(false);
    }
  });
});

describe('validation messages', () => {
  const broken = [
    profileFormSchema.safeParse({ displayName: 'x'.repeat(999), email: 'not-an-address' }),
    profileFormSchema.safeParse({ displayName: '', email: `${'a'.repeat(300)}@example.com` }),
    profileUpdateSchema.safeParse({}),
  ];
  const messages = new Set(broken.flatMap((r) => r.error?.issues ?? []).map((i) => i.message));
  const flat = flattenMessages(en);

  it('are translation keys in en.json, using only VALIDATION_LIMITS', () => {
    expect(messages.size).toBeGreaterThanOrEqual(4);
    for (const message of messages) {
      expect(message in flat, `${message} in en.json`).toBe(true);
      for (const name of placeholders(flat[message])) {
        expect(Object.keys(VALIDATION_LIMITS), `${message}: {{${name}}}`).toContain(name);
      }
    }
  });
});
