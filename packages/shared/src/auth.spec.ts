import { describe, expect, it } from 'vitest';
import {
  changePasswordFormSchema,
  changePasswordRequestSchema,
  loginRequestSchema,
  meResponseSchema,
  newPasswordSchema,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  publicUserSchema,
  setupFormSchema,
  setupRequestSchema,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  usernameSchema,
} from './auth.js';

const validPassword = 'a'.repeat(PASSWORD_MIN_LENGTH);
const validSetup = { setupToken: 'K7QD-9F2M', username: 'owner', password: validPassword };

describe('usernameSchema', () => {
  it('accepts the length boundaries', () => {
    expect(usernameSchema.safeParse('a'.repeat(USERNAME_MIN_LENGTH)).success).toBe(true);
    expect(usernameSchema.safeParse('a'.repeat(USERNAME_MAX_LENGTH)).success).toBe(true);
  });

  it('rejects just outside the length boundaries', () => {
    expect(usernameSchema.safeParse('a'.repeat(USERNAME_MIN_LENGTH - 1)).success).toBe(false);
    expect(usernameSchema.safeParse('a'.repeat(USERNAME_MAX_LENGTH + 1)).success).toBe(false);
  });

  it('normalises to trimmed lowercase before checking', () => {
    expect(usernameSchema.parse('  Owner.Name_1-x  ')).toBe('owner.name_1-x');
  });

  it('rejects characters outside the allowed set', () => {
    for (const name of ['own er', 'owner!', 'ownér', 'owner/..', 'ow<script>']) {
      expect(usernameSchema.safeParse(name).success, name).toBe(false);
    }
  });
});

describe('newPasswordSchema', () => {
  it('accepts the length boundaries', () => {
    expect(newPasswordSchema.safeParse('a'.repeat(PASSWORD_MIN_LENGTH)).success).toBe(true);
    expect(newPasswordSchema.safeParse('a'.repeat(PASSWORD_MAX_LENGTH)).success).toBe(true);
  });

  it('rejects just outside the length boundaries', () => {
    expect(newPasswordSchema.safeParse('a'.repeat(PASSWORD_MIN_LENGTH - 1)).success).toBe(false);
    expect(newPasswordSchema.safeParse('a'.repeat(PASSWORD_MAX_LENGTH + 1)).success).toBe(false);
  });

  it('does not trim or otherwise change the password', () => {
    expect(newPasswordSchema.parse(`  ${validPassword}  `)).toBe(`  ${validPassword}  `);
  });
});

describe('loginRequestSchema', () => {
  it('accepts a password shorter than the current minimum', () => {
    const result = loginRequestSchema.safeParse({ username: 'owner', password: 'short' });
    expect(result.success).toBe(true);
  });

  it('accepts a username that would not pass the choosing rules', () => {
    expect(loginRequestSchema.safeParse({ username: 'ab', password: 'x' }).success).toBe(true);
  });

  it('normalises the username', () => {
    expect(loginRequestSchema.parse({ username: ' Owner ', password: 'x' }).username).toBe('owner');
  });

  it('rejects an empty password and one over the maximum', () => {
    expect(loginRequestSchema.safeParse({ username: 'owner', password: '' }).success).toBe(false);
    const tooLong = 'a'.repeat(PASSWORD_MAX_LENGTH + 1);
    expect(loginRequestSchema.safeParse({ username: 'owner', password: tooLong }).success).toBe(
      false,
    );
  });

  it('rejects unknown fields', () => {
    const result = loginRequestSchema.safeParse({ username: 'owner', password: 'x', admin: true });
    expect(result.success).toBe(false);
  });
});

describe('setupRequestSchema', () => {
  it('accepts a valid request', () => {
    expect(setupRequestSchema.safeParse(validSetup).success).toBe(true);
  });

  it('applies the choosing rules to username and password', () => {
    expect(setupRequestSchema.safeParse({ ...validSetup, username: 'ab' }).success).toBe(false);
    expect(setupRequestSchema.safeParse({ ...validSetup, password: 'short' }).success).toBe(false);
  });

  it('rejects a missing or oversized setup token', () => {
    expect(setupRequestSchema.safeParse({ ...validSetup, setupToken: '  ' }).success).toBe(false);
    expect(
      setupRequestSchema.safeParse({ ...validSetup, setupToken: 'A'.repeat(65) }).success,
    ).toBe(false);
  });

  it('rejects unknown fields, including the form-only confirmation', () => {
    const result = setupRequestSchema.safeParse({ ...validSetup, confirmPassword: validPassword });
    expect(result.success).toBe(false);
  });
});

describe('changePasswordRequestSchema', () => {
  it('checks the current password only for presence', () => {
    const result = changePasswordRequestSchema.safeParse({
      currentPassword: 'old',
      newPassword: validPassword,
    });
    expect(result.success).toBe(true);
  });

  it('applies the choosing rules to the new password', () => {
    const result = changePasswordRequestSchema.safeParse({
      currentPassword: 'old',
      newPassword: 'short',
    });
    expect(result.success).toBe(false);
  });
});

describe('form schemas', () => {
  it('report a confirmation mismatch on the confirmation field', () => {
    const result = setupFormSchema.safeParse({ ...validSetup, confirmPassword: 'different' });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toContainEqual(['confirmPassword']);
  });

  it('accept matching confirmations', () => {
    expect(
      setupFormSchema.safeParse({ ...validSetup, confirmPassword: validPassword }).success,
    ).toBe(true);
    const change = {
      currentPassword: 'old',
      newPassword: validPassword,
      confirmNewPassword: validPassword,
    };
    expect(changePasswordFormSchema.safeParse(change).success).toBe(true);
  });
});

describe('response schemas', () => {
  const user = {
    id: '0192f3a1-7c2e-7a4b-9d1e-3f5a7c9b2d4e',
    username: 'owner',
    createdAt: '2026-10-11T12:00:00.000Z',
  };

  it('publicUserSchema strips anything that is not public', () => {
    const parsed = publicUserSchema.parse({ ...user, passwordHash: '$scrypt$secret' });
    expect(parsed).toEqual(user);
    expect(parsed).not.toHaveProperty('passwordHash');
  });

  it('meResponseSchema accepts a user or null', () => {
    expect(meResponseSchema.safeParse({ user }).success).toBe(true);
    expect(meResponseSchema.safeParse({ user: null }).success).toBe(true);
  });
});
