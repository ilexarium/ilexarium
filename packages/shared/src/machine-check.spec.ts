import { describe, expect, it } from 'vitest';
import { personCheckSchema } from './machine-check.js';

describe('personCheckSchema', () => {
  it('accepts every step passed, and the later steps not checked after the helper failed', () => {
    for (const check of [
      { helper: 'ok', userUnits: true, docker: 'user_units' },
      { helper: 'ok', userUnits: false, docker: 'system_units' },
      { helper: 'unavailable', userUnits: null, docker: null },
      { helper: 'wrong_account', userUnits: null, docker: null },
    ]) {
      expect(personCheckSchema.safeParse(check).success, JSON.stringify(check)).toBe(true);
    }
  });

  it('refuses unknown codes', () => {
    expect(
      personCheckSchema.safeParse({ helper: 'maybe', userUnits: null, docker: null }).success,
    ).toBe(false);
    expect(
      personCheckSchema.safeParse({ helper: 'ok', userUnits: true, docker: 'root' }).success,
    ).toBe(false);
  });
});
