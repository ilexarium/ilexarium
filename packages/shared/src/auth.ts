import { z } from 'zod';
import { CATALOG_LIMITS } from './catalog.js';

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;
export const USERNAME_PATTERN = /^[a-z0-9_.-]+$/;
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
const SETUP_TOKEN_MAX_LENGTH = 64;

/**
 * The numbers validation messages mention — their `{{ }}` parameters. Messages are translation
 * keys (`@homelab/i18n`): the browser's checks and the server's 400s carry the same key, and the
 * web app words it with these values, so no limit is ever written into a translation.
 */
export const VALIDATION_LIMITS = {
  usernameMin: USERNAME_MIN_LENGTH,
  usernameMax: USERNAME_MAX_LENGTH,
  passwordMin: PASSWORD_MIN_LENGTH,
  passwordMax: PASSWORD_MAX_LENGTH,
  portMin: CATALOG_LIMITS.portMin,
  portMax: CATALOG_LIMITS.portMax,
  secretMin: CATALOG_LIMITS.secretMin,
  secretMax: CATALOG_LIMITS.secretMax,
  textMax: CATALOG_LIMITS.textMax,
  // Backups (`BACKUP_LIMITS`; written out here, as backups.ts imports this file).
  backupDailyMin: 1,
  backupDailyMax: 365,
  backupWeeklyMax: 104,
  backupMonthlyMax: 120,
  // Disks (`DISK_NAME_MAX` in disks.ts).
  diskNameMax: 32,
  // The Assistant (`AI_LIMITS.messageMax` in ai.ts).
  messageMax: 16_000,
} as const;

/** Username when choosing one (setup). Normalised to lowercase before the checks run. */
export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(USERNAME_MIN_LENGTH, 'validation.usernameTooShort')
  .max(USERNAME_MAX_LENGTH, 'validation.usernameTooLong')
  .regex(USERNAME_PATTERN, 'validation.usernameInvalid');

/** Password when choosing one (setup, change). Length only — no composition rules (NIST 800-63B). */
export const newPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, 'validation.passwordTooShort')
  .max(PASSWORD_MAX_LENGTH, 'validation.passwordTooLong');

/**
 * An existing password (login, current password on change): present and bounded only.
 * The choosing rules must not apply here, or raising the minimum later would lock users out.
 */
export const existingPasswordSchema = z
  .string()
  .min(1, 'validation.passwordRequired')
  .max(PASSWORD_MAX_LENGTH, 'validation.passwordTooLong');

// Requests — strict: unknown fields are rejected.

export const loginRequestSchema = z.strictObject({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, 'validation.usernameRequired')
    .max(USERNAME_MAX_LENGTH, 'validation.usernameTooLong'),
  password: existingPasswordSchema,
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const setupRequestSchema = z.strictObject({
  /** Normalised (case, dashes, spaces) and compared by the server. */
  setupToken: z
    .string()
    .trim()
    .min(1, 'validation.setupCodeRequired')
    .max(SETUP_TOKEN_MAX_LENGTH, 'validation.setupCodeInvalid'),
  username: usernameSchema,
  password: newPasswordSchema,
});
export type SetupRequest = z.infer<typeof setupRequestSchema>;

export const changePasswordRequestSchema = z.strictObject({
  currentPassword: existingPasswordSchema,
  newPassword: newPasswordSchema,
});
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

// Form-only schemas: add the confirmation field the server never receives.

export const setupFormSchema = setupRequestSchema
  .extend({ confirmPassword: z.string() })
  .refine((form) => form.password === form.confirmPassword, {
    path: ['confirmPassword'],
    error: 'validation.passwordsMismatch',
  });
export type SetupForm = z.infer<typeof setupFormSchema>;

export const changePasswordFormSchema = changePasswordRequestSchema
  .extend({ confirmNewPassword: z.string() })
  .refine((form) => form.newPassword === form.confirmNewPassword, {
    path: ['confirmNewPassword'],
    error: 'validation.passwordsMismatch',
  });
export type ChangePasswordForm = z.infer<typeof changePasswordFormSchema>;

// Responses.

/** The only user shape the API ever returns — never contains the password hash. */
export const publicUserSchema = z.object({
  id: z.uuid(),
  username: z.string(),
  createdAt: z.iso.datetime(),
});
export type PublicUser = z.infer<typeof publicUserSchema>;

export const authStatusResponseSchema = z.object({
  needsSetup: z.boolean(),
});
export type AuthStatusResponse = z.infer<typeof authStatusResponseSchema>;

/** Returned by setup and login. */
export const userResponseSchema = z.object({
  user: publicUserSchema,
});
export type UserResponse = z.infer<typeof userResponseSchema>;

/** `GET /auth/me` is optional: `null` when nobody is signed in, never a 401. */
export const meResponseSchema = z.object({
  user: publicUserSchema.nullable(),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

// Errors.

export const AUTH_ERROR_CODES = {
  invalidCredentials: 'invalid_credentials',
  invalidSetupToken: 'invalid_setup_token',
  setupNotAvailable: 'setup_not_available',
  wrongPassword: 'wrong_password',
  tooManyAttempts: 'too_many_attempts',
} as const;
export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[keyof typeof AUTH_ERROR_CODES];

/** One field problem in a 400 response. Never carries the submitted value. */
export const fieldErrorSchema = z.object({
  field: z.string(),
  code: z.string(),
  message: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});
export type FieldError = z.infer<typeof fieldErrorSchema>;

export const apiErrorResponseSchema = z.object({
  message: z.string(),
  code: z.string().optional(),
  errors: z.array(fieldErrorSchema).optional(),
});
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
