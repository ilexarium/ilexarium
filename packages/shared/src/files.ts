import { z } from 'zod';

/**
 * Linux sign-in and the file explorer (docs/plans/files_and_terminal.md): the machine's files,
 * worked with as a Linux account over SSH to the machine itself — exactly what Linux allows that
 * account, no limits of the app's own.
 */

export const FILES_LIMITS = {
  /** Linux user names (useradd's default rules, at most 32 characters). */
  usernameMax: 32,
  passwordMax: 1024,
  /** Linux's PATH_MAX. */
  pathMax: 4096,
  /** Linux's NAME_MAX (bytes; checked on characters here, Linux checks the rest). */
  nameMax: 255,
  /** One upload, at most. */
  uploadMaxBytes: 10 * 1024 ** 3,
  /** A Linux session closes after this long without use. */
  idleMinutes: 30,
  /** "How much is in this folder" stops counting here. */
  summaryMaxEntries: 10_000,
} as const;

export const FILES_ERROR_CODES = {
  /** No Linux session (signed out, or closed after 30 minutes without use). */
  linuxSessionRequired: 'linux_session_required',
  /** The user name or password was refused (or the account can't sign in). */
  linuxLoginRefused: 'linux_login_refused',
  /** root never signs in here. */
  linuxRootRefused: 'linux_root_refused',
  /** The machine's SSH server doesn't answer, or isn't the one expected (host key). */
  sshUnavailable: 'ssh_unavailable',
  notFound: 'file_not_found',
  permissionDenied: 'permission_denied',
  /** Something is already there (upload without replacing, rename onto it, new folder). */
  exists: 'file_exists',
  /** Download of a folder, listing of a file, … */
  wrongType: 'wrong_type',
  tooLarge: 'file_too_large',
  /** Anything else the SSH server refused (a full disk, a folder not empty, …). */
  failed: 'file_operation_failed',
} as const;
export type FilesErrorCode = (typeof FILES_ERROR_CODES)[keyof typeof FILES_ERROR_CODES];

/** An absolute path, normalised enough to read; what it may reach is Linux's decision. */
export const filePathSchema = z
  .string()
  .min(1)
  .max(FILES_LIMITS.pathMax)
  .refine((path) => path.startsWith('/') && !path.includes('\0'), 'An absolute path');

/** A file or folder name: one part of a path. */
export const fileNameSchema = z
  .string()
  .trim()
  .min(1, 'validation.fileNameRequired')
  .max(FILES_LIMITS.nameMax, 'validation.fileNameTooLong')
  .refine(
    (name) => name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\0'),
    'validation.fileNameInvalid',
  );

/** `POST /api/files/session`: sign in as a Linux user. */
export const linuxSignInRequestSchema = z.strictObject({
  username: z
    .string()
    .trim()
    .min(1, 'validation.usernameRequired')
    .max(FILES_LIMITS.usernameMax, 'validation.linuxUsernameInvalid')
    .regex(/^[a-z_][a-z0-9_.-]*\$?$/, 'validation.linuxUsernameInvalid'),
  password: z
    .string()
    .min(1, 'validation.passwordRequired')
    .max(FILES_LIMITS.passwordMax, 'validation.passwordTooLong'),
});
export type LinuxSignInRequest = z.infer<typeof linuxSignInRequestSchema>;

/** The Linux session of this browser session. */
export const linuxSessionSchema = z.object({
  username: z.string(),
  /** Where the explorer starts. */
  home: z.string(),
  /** The account's uid (whose processes it may end); null if it couldn't be found out. */
  uid: z.number().int().nonnegative().nullable(),
});
export type LinuxSession = z.infer<typeof linuxSessionSchema>;

export const FILE_TYPES = ['folder', 'file', 'link', 'other'] as const;
export const fileTypeSchema = z.enum(FILE_TYPES);
export type FileType = z.infer<typeof fileTypeSchema>;

export const fileEntrySchema = z.object({
  name: z.string(),
  type: fileTypeSchema,
  /** A link's target: a folder (opened) or a file (downloaded); null if it leads nowhere. */
  linkTarget: z.enum(['folder', 'file']).nullable(),
  /** Bytes (a link's own size). */
  size: z.number().nonnegative(),
  modifiedAt: z.iso.datetime(),
  /** The owner's account name, or its uid when the machine doesn't know it. */
  owner: z.string(),
  /** Like `ls -l`: `rwxr-x---`. */
  permissions: z.string(),
});
export type FileEntry = z.infer<typeof fileEntrySchema>;

/** `GET /api/files/list?path=` — a folder's contents, folders first. */
export const fileListSchema = z.object({
  path: z.string(),
  /** Null at `/`. */
  parent: z.string().nullable(),
  entries: z.array(fileEntrySchema),
});
export type FileList = z.infer<typeof fileListSchema>;

/** `GET /api/files/summary?path=` — what a delete would remove. */
export const fileSummarySchema = z.object({
  type: fileTypeSchema,
  files: z.number().int().nonnegative(),
  folders: z.number().int().nonnegative(),
  bytes: z.number().nonnegative(),
  /** Counting stopped at `summaryMaxEntries`: there's more. */
  truncated: z.boolean(),
});
export type FileSummary = z.infer<typeof fileSummarySchema>;

export const filePathQuerySchema = z.strictObject({ path: filePathSchema });
export type FilePathQuery = z.infer<typeof filePathQuerySchema>;

/** `PUT /api/files/upload?folder=&name=&replace=` — the file itself is the body. */
export const fileUploadQuerySchema = z.strictObject({
  folder: filePathSchema,
  name: fileNameSchema,
  replace: z.enum(['true', 'false']).default('false'),
});
export type FileUploadQuery = z.infer<typeof fileUploadQuerySchema>;

/** `POST /api/files/folder` — a new folder in `parent`. */
export const newFolderRequestSchema = z.strictObject({
  parent: filePathSchema,
  name: fileNameSchema,
});
export type NewFolderRequest = z.infer<typeof newFolderRequestSchema>;

/** `POST /api/files/rename` — rename or move (never onto something that exists). */
export const fileRenameRequestSchema = z.strictObject({
  from: filePathSchema,
  to: filePathSchema,
});
export type FileRenameRequest = z.infer<typeof fileRenameRequestSchema>;
