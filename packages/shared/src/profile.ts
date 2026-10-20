import { z } from 'zod';
import { userLanguageSchema, VALIDATION_LIMITS } from './auth.js';

export const PROFILE_LIMITS = {
  displayNameMax: VALIDATION_LIMITS.displayNameMax,
  emailMax: VALIDATION_LIMITS.emailMax,
  /** The picture is a square of exactly this many pixels (the browser draws it so). */
  pictureSize: 600,
  pictureMaxBytes: 1024 * 1024,
} as const;

/** What the server accepts, judged by the bytes; the browser makes WebP, or JPEG without it. */
export const PROFILE_PICTURE_TYPES = ['image/webp', 'image/jpeg', 'image/png'] as const;
export type ProfilePictureType = (typeof PROFILE_PICTURE_TYPES)[number];

/** `GET` / `PUT` / `DELETE`: the signed-in person's picture. */
export const PROFILE_AVATAR_PATH = '/api/profile/avatar';

export const PROFILE_ERROR_CODES = {
  /** Not a WebP, JPEG or PNG of exactly `pictureSize` × `pictureSize`. */
  invalidPicture: 'invalid_picture',
  /** Over `pictureMaxBytes`. */
  pictureTooLarge: 'picture_too_large',
} as const;
export type ProfileErrorCode = (typeof PROFILE_ERROR_CODES)[keyof typeof PROFILE_ERROR_CODES];

/** Empty means none. */
export const displayNameSchema = z
  .string()
  .trim()
  .max(PROFILE_LIMITS.displayNameMax, 'validation.displayNameTooLong');

/** Empty means none. */
export const contactEmailSchema = z
  .string()
  .trim()
  .max(PROFILE_LIMITS.emailMax, 'validation.emailTooLong')
  .refine((value) => value === '' || z.email().safeParse(value).success, 'validation.emailInvalid');

/** The edit dialog's fields. */
export const profileFormSchema = z.strictObject({
  displayName: displayNameSchema,
  email: contactEmailSchema,
});
export type ProfileForm = z.infer<typeof profileFormSchema>;

/** `PATCH /api/profile`: what changes; an empty name or email removes it. Answers `UserResponse`. */
export const profileUpdateSchema = profileFormSchema
  .extend({ language: userLanguageSchema })
  .partial()
  .refine((update) => Object.keys(update).length > 0, 'validation.nothingToChange');
export type ProfileUpdate = z.infer<typeof profileUpdateSchema>;
