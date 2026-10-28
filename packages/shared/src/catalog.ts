import { z } from 'zod';

/**
 * Templates (`catalog/<id>/`): a starting point for an app — `compose.yml` with `${VARIABLES}`,
 * `template.json` (what each variable is, the backup preset) and `icon.svg`. Used once: the app
 * that comes from it is the person's own folder. Design: docs/plans/acting_as_you.md, "Templates".
 */

export const CATALOG_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** A template's variable: also its `${KEY}` in compose.yml and its line in `.env`. */
export const FIELD_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

export const CATALOG_LIMITS = {
  maxFields: 30,
  portMin: 1,
  portMax: 65535,
  secretMin: 12,
  secretMax: 128,
  generatedSecretLength: 32,
  textMax: 1024,
  pathMax: 1024,
  maxBackupSkips: 20,
  backupSkipMax: 255,
} as const;

export const CATALOG_CATEGORIES = [
  'media',
  'photos',
  'productivity',
  'monitoring',
  'network',
  'tools',
] as const;
export const catalogCategorySchema = z.enum(CATALOG_CATEGORIES);
export type CatalogCategory = z.infer<typeof catalogCategorySchema>;

/** Control characters never appear in a path. */
export const PATH_FORBIDDEN = /[\x00-\x1f\x7f]/;

/** An absolute path in its plain form: starts with "/", no empty, "." or ".." parts, no trailing "/". */
export function isPlainAbsolutePath(path: string): boolean {
  if (!path.startsWith('/') || path.length > CATALOG_LIMITS.pathMax) return false;
  if (PATH_FORBIDDEN.test(path)) return false;
  if (path === '/') return true;
  return path
    .slice(1)
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * A path below a folder, written relatively (`data/cache`): no leading "/" or "-", no "." or ".."
 * parts, one line. `*` and `?` match within a name (a skip pattern).
 */
export const RELATIVE_PATH_PATTERN =
  /^(?![/-])(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*\/$)[^\x00-\x1f\x7f\\[\]]{1,255}$/;

// Fields.

/**
 * What a variable is, for the form: `port` (a published port), `folder` (a bind mount's source),
 * `secret` (entered, shown masked), `generated` (a random secret made at setup), `version` (an
 * image's tag: the versions list), `text`. Only a hint — any text is accepted.
 */
export const FIELD_KINDS = ['text', 'port', 'folder', 'secret', 'generated', 'version'] as const;
export const fieldKindSchema = z.enum(FIELD_KINDS);
export type FieldKind = z.infer<typeof fieldKindSchema>;

export const templateFieldSchema = z.strictObject({
  key: z.string().regex(FIELD_KEY_PATTERN),
  kind: fieldKindSchema,
  default: z.union([z.string(), z.number()]).optional(),
  /** `version`: the image (without tag) whose versions are listed. */
  image: z.string().min(1).max(255).optional(),
  /** Folded under "Advanced": the default works. */
  advanced: z.boolean().optional(),
});
export type TemplateField = z.infer<typeof templateFieldSchema>;

// Backups.

/** `stop`: stopped while it's copied, started again after; `live`: copied while it runs. */
export const BACKUP_MODES = ['live', 'stop'] as const;
export const backupModeSchema = z.enum(BACKUP_MODES);
export type BackupMode = z.infer<typeof backupModeSchema>;

export const backupSkipSchema = z
  .string()
  .max(CATALOG_LIMITS.backupSkipMax)
  .regex(RELATIVE_PATH_PATTERN, 'validation.backupSkipInvalid');

/** A template's backup preset: how, and what to skip (relative to the app's folder). */
export const templateBackupSchema = z.strictObject({
  mode: backupModeSchema,
  skip: z.array(backupSkipSchema).max(CATALOG_LIMITS.maxBackupSkips).optional(),
  /** After a restore, show `catalog.<id>.backup.restoreNote` (e.g. "restore the database in …"). */
  restoreNote: z.boolean().optional(),
});

// Templates.

export const templateSchema = z
  .strictObject({
    id: z.string().regex(CATALOG_ID_PATTERN),
    /** The template's own version: changes when its compose.yml changes. */
    version: z.string().regex(/^[0-9]{1,6}$/),
    /** A proper noun: not translated. Description, labels, help and note are `catalog.<id>.*` keys. */
    name: z.string().min(1).max(40),
    category: catalogCategorySchema,
    website: z.url({ protocol: /^https$/ }),
    /** The port its web page listens on inside the container (the "Open" link); none for an app without one (Ollama). */
    web: z.strictObject({ port: z.number().int().min(1).max(65535) }).optional(),
    fields: z.array(templateFieldSchema).min(1).max(CATALOG_LIMITS.maxFields),
    backup: templateBackupSchema.optional(),
    /** `catalog.<id>.note`: what changed in this version, what to copy (shown at setup and when it's newer). */
    note: z.boolean().optional(),
  })
  .superRefine((template, ctx) => {
    const keys = template.fields.map((field) => field.key);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: 'custom', path: ['fields'], message: 'field keys must be unique' });
    }
    template.fields.forEach((field, i) => {
      if ((field.kind === 'version') !== (field.image !== undefined)) {
        ctx.addIssue({
          code: 'custom',
          path: ['fields', i, 'image'],
          message: 'an image for version fields, and only for them',
        });
      }
    });
  });
export type Template = z.infer<typeof templateSchema>;

/** The `${KEY}` and `${KEY:-default}` (and the like) variables of a Compose file, each once, in order. */
export function templatePlaceholders(text: string): string[] {
  const keys = [...text.matchAll(/(?<!\$)\$\{([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
  return [...new Set(keys)];
}

/** One card of `GET /api/catalog`. */
export const templateSummarySchema = z.object({
  id: z.string(),
  version: z.string(),
  name: z.string(),
  category: catalogCategorySchema,
  website: z.string(),
  /** Its web page's port inside the container (the "Open" link), or null. */
  webPort: z.number().int().nullable(),
  /** After a restore, show `catalog.<id>.backup.restoreNote`. */
  backupRestoreNote: z.boolean(),
});
export type TemplateSummary = z.infer<typeof templateSummarySchema>;

/** `GET /api/catalog/:id`: the template and its files, to start the setup form from. */
export const templateDetailsSchema = z.object({
  template: templateSchema,
  compose: z.string(),
});
export type TemplateDetails = z.infer<typeof templateDetailsSchema>;

export const catalogIdParamsSchema = z.strictObject({ id: z.string().regex(CATALOG_ID_PATTERN) });
export type CatalogIdParams = z.infer<typeof catalogIdParamsSchema>;

/** The templates: `GET` their list. */
export const CATALOG_PATH = '/api/catalog';

/** One template: `GET` it with its compose.yml. */
export function catalogEntryPath(id: string): string {
  return `${CATALOG_PATH}/${encodeURIComponent(id)}`;
}

/** A template's icon: an SVG, only ever shown through <img>. */
export function catalogIconPath(id: string): string {
  return `${catalogEntryPath(id)}/icon`;
}
