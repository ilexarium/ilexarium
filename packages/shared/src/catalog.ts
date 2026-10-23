import { z } from 'zod';

/**
 * The service catalog: `catalog/<id>/meta.json` describes a reviewed Compose recipe's blanks —
 * which values a user may fill in, of which type. The same rules are checked in the browser, by
 * the server and (written independently) by the root wrapper `system/wrappers/laris-compose.ts`.
 * Design: docs/plans/service_deploys.md.
 */

export const CATALOG_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** Also the `${KEY}` placeholder in the entry's compose.yml. */
export const FIELD_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,39}$/;

export const CATALOG_LIMITS = {
  maxFields: 20,
  portMin: 1024,
  portMax: 65535,
  secretMin: 12,
  secretMax: 128,
  generatedSecretLength: 32,
  textMax: 128,
  pathMax: 1024,
  /** Names skipped inside one backed-up folder. */
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

/**
 * The patterns a `text` field may use, by name — never a free regular expression: each one is
 * implemented and tested in every place that checks it (browser, server, wrapper).
 */
export const TEXT_PATTERNS = {
  /** Lowercase letters, digits, ".", "_" and "-". */
  username: /^[a-z0-9_.-]{1,64}$/,
  /** An IANA time zone name, e.g. "Europe/Berlin", "America/Argentina/Buenos_Aires", "UTC". */
  timezone: /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/,
} as const;
export type TextPattern = keyof typeof TEXT_PATTERNS;
const textPatternSchema = z.enum(Object.keys(TEXT_PATTERNS) as [TextPattern, ...TextPattern[]]);

/** An `enum` option: plain machine text, also safe as a Compose value. */
export const ENUM_OPTION_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Control characters, ":" (Compose's mount separator) and "," never appear in a folder. */
export const PATH_FORBIDDEN = /[\x00-\x1f\x7f:,]/;
/** A secret: printable, one line. */
const SECRET_PATTERN = /^[^\x00-\x1f\x7f]+$/;

/**
 * An absolute folder path in its plain form: starts with "/", no empty, "." or ".." segments, no
 * trailing "/". Where it may be (the storage roots) is checked by the server and the wrapper.
 */
export function isPlainAbsolutePath(path: string): boolean {
  if (!path.startsWith('/') || path.length > CATALOG_LIMITS.pathMax) return false;
  if (PATH_FORBIDDEN.test(path)) return false;
  if (path === '/') return true;
  return path
    .slice(1)
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

// Fields.

const fieldBase = {
  key: z.string().regex(FIELD_KEY_PATTERN),
  /** Shown under "Advanced", folded away: the default works. */
  advanced: z.boolean().optional(),
};
const portNumber = z.number().int().min(CATALOG_LIMITS.portMin).max(CATALOG_LIMITS.portMax);

export const portFieldSchema = z.strictObject({
  ...fieldBase,
  type: z.literal('port'),
  default: portNumber,
});
export const pathFieldSchema = z.strictObject({
  ...fieldBase,
  type: z.literal('path'),
  default: z.string().refine(isPlainAbsolutePath, 'not a plain absolute path'),
  /** `read` mounts it read-only: the service can't change or delete anything in it. */
  access: z.enum(['read', 'write']),
});
export const textFieldSchema = z.strictObject({
  ...fieldBase,
  type: z.literal('text'),
  pattern: textPatternSchema,
  default: z.string().max(CATALOG_LIMITS.textMax).optional(),
});
/** Entered by the user (e.g. an admin password); stored encrypted, never sent back. */
export const secretFieldSchema = z.strictObject({ ...fieldBase, type: z.literal('secret') });
/** Made by the server (e.g. a database password); never shown, never asked. */
export const generatedSecretFieldSchema = z.strictObject({
  ...fieldBase,
  type: z.literal('generatedSecret'),
});
export const enumFieldSchema = z.strictObject({
  ...fieldBase,
  type: z.literal('enum'),
  options: z.array(z.string().regex(ENUM_OPTION_PATTERN)).min(2).max(20),
  default: z.string(),
});
export const booleanFieldSchema = z.strictObject({
  ...fieldBase,
  type: z.literal('boolean'),
  default: z.boolean(),
});

export const catalogFieldSchema = z.discriminatedUnion('type', [
  portFieldSchema,
  pathFieldSchema,
  textFieldSchema,
  secretFieldSchema,
  generatedSecretFieldSchema,
  enumFieldSchema,
  booleanFieldSchema,
]);
export type CatalogField = z.infer<typeof catalogFieldSchema>;
export type CatalogFieldType = CatalogField['type'];

/** Fields the user fills in (a generated secret is the server's). */
export type UserField = Exclude<CatalogField, { type: 'generatedSecret' }>;
export const isUserField = (field: CatalogField): field is UserField =>
  field.type !== 'generatedSecret';
/** Fields whose values are secret: stored encrypted, masked in output, never sent back. */
export const isSecretField = (field: CatalogField): boolean =>
  field.type === 'secret' || field.type === 'generatedSecret';

// Backups.

/**
 * How a service's data stays consistent while it is copied: `live` (copied while it runs — its
 * data is safe to read then, e.g. it writes its own database dumps) or `stop` (stopped briefly,
 * started again afterwards). Declared by the recipe, never coded per service.
 */
export const BACKUP_MODES = ['live', 'stop'] as const;
export const backupModeSchema = z.enum(BACKUP_MODES);
export type BackupMode = z.infer<typeof backupModeSchema>;

/**
 * A name skipped inside a backed-up folder (e.g. a cache the service rebuilds): one plain name —
 * no "/", no "." or "..", no wildcards, no leading "-" (it must never read as a pattern or an option).
 */
export const BACKUP_SKIP_PATTERN = /^(?!-)(?!\.{1,2}$)[^/\x00-\x1f\x7f*?[\]\\]+$/;

export const backupSkipSchema = z
  .string()
  .max(CATALOG_LIMITS.backupSkipMax)
  .regex(BACKUP_SKIP_PATTERN, 'not a plain name');

/**
 * What a recipe's backup covers: some of its folder fields (named volumes are never backed up —
 * important data must be in folder fields). Design: docs/plans/backups.md, section 2.
 */
export const catalogBackupSchema = z.strictObject({
  folders: z
    .array(
      z.strictObject({
        field: z.string().regex(FIELD_KEY_PATTERN),
        skip: z.array(backupSkipSchema).max(CATALOG_LIMITS.maxBackupSkips).optional(),
      }),
    )
    .min(1)
    .max(CATALOG_LIMITS.maxFields),
  mode: backupModeSchema,
  /** After a restore, show `catalog.<id>.backup.restoreNote` (e.g. "restore the database in …"). */
  restoreNote: z.boolean().optional(),
});
export type CatalogBackup = z.infer<typeof catalogBackupSchema>;

// Entries.

export const catalogMetaSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: z.string().regex(CATALOG_ID_PATTERN),
    /** The entry's own version: changes when its recipe changes. */
    version: z.string().regex(/^[0-9]{1,6}$/),
    /** A proper noun: not translated. Description and labels are `catalog.<id>.*` keys. */
    name: z.string().min(1).max(40),
    category: catalogCategorySchema,
    website: z.url({ protocol: /^https$/ }),
    /** The port field behind the "Open" link; none for a service without a web page of its own (Ollama). */
    webPort: z.string().regex(FIELD_KEY_PATTERN).optional(),
    /** Owner of folders the wrapper creates for this service (its containers' user). */
    dataOwner: z.strictObject({
      uid: z.number().int().min(0).max(65535),
      gid: z.number().int().min(0).max(65535),
    }),
    fields: z.array(catalogFieldSchema).min(1).max(CATALOG_LIMITS.maxFields),
    /** Without it, the service can't be backed up. */
    backup: catalogBackupSchema.optional(),
  })
  .superRefine((meta, ctx) => {
    const keys = meta.fields.map((field) => field.key);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: 'custom', path: ['fields'], message: 'field keys must be unique' });
    }
    const web = meta.fields.find((field) => field.key === meta.webPort);
    if (meta.webPort !== undefined && web?.type !== 'port') {
      ctx.addIssue({ code: 'custom', path: ['webPort'], message: 'must name a port field' });
    }
    meta.fields.forEach((field, i) => {
      if (field.type === 'enum' && !field.options.includes(field.default)) {
        ctx.addIssue({ code: 'custom', path: ['fields', i, 'default'], message: 'not an option' });
      }
      if (field.type === 'text' && field.default !== undefined) {
        if (!TEXT_PATTERNS[field.pattern].test(field.default)) {
          ctx.addIssue({ code: 'custom', path: ['fields', i, 'default'], message: 'no match' });
        }
      }
    });
    const backupFields = meta.backup?.folders.map((folder) => folder.field) ?? [];
    if (new Set(backupFields).size !== backupFields.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['backup', 'folders'],
        message: 'fields must be unique',
      });
    }
    meta.backup?.folders.forEach((folder, i) => {
      const field = meta.fields.find((f) => f.key === folder.field);
      if (field?.type !== 'path') {
        ctx.addIssue({
          code: 'custom',
          path: ['backup', 'folders', i, 'field'],
          message: 'must name a folder field',
        });
      }
      const skips = folder.skip ?? [];
      if (new Set(skips).size !== skips.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['backup', 'folders', i, 'skip'],
          message: 'not unique',
        });
      }
    });
  });
export type CatalogMeta = z.infer<typeof catalogMetaSchema>;

/** The `${KEY}` placeholders of a Compose template, each once, in order of appearance. */
export function templatePlaceholders(template: string): string[] {
  const keys = [...template.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)].map((match) => match[1]);
  return [...new Set(keys)];
}

// Values.

/** A field's value: a port number, a boolean, or text (folders, secrets, options). */
export type FieldValue = string | number | boolean;
export type FieldValues = Record<string, FieldValue>;

/**
 * The values a user may send for an entry: exactly its user fields, each checked by its type.
 * Messages are `validation.*` keys with limits from `VALIDATION_LIMITS`. Where a folder may be
 * (the storage roots) and whether a port is free are the server's checks.
 */
export function valuesSchema(meta: CatalogMeta, { keptSecrets = [] }: ValuesSchemaOptions = {}) {
  const shape: Record<string, z.ZodType<FieldValue>> = {};
  for (const field of meta.fields) {
    if (!isUserField(field)) continue;
    const schema = fieldValueSchema(field);
    // A previous install's secret: left empty, it keeps its value.
    shape[field.key] = keptSecrets.includes(field.key) ? z.literal('').or(schema) : schema;
  }
  return z.strictObject(shape);
}

export interface ValuesSchemaOptions {
  /** Secret fields that already have a value (a reinstall): empty means "keep it". */
  keptSecrets?: readonly string[];
}

export function fieldValueSchema(field: UserField): z.ZodType<FieldValue> {
  switch (field.type) {
    case 'port':
      return z
        .number('validation.portInvalid')
        .int('validation.portInvalid')
        .min(CATALOG_LIMITS.portMin, 'validation.portRange')
        .max(CATALOG_LIMITS.portMax, 'validation.portRange');
    case 'path':
      return z
        .string()
        .min(1, 'validation.pathRequired')
        .refine(isPlainAbsolutePath, 'validation.pathInvalid');
    case 'text':
      return z
        .string()
        .min(1, 'validation.textRequired')
        .max(CATALOG_LIMITS.textMax, 'validation.textTooLong')
        .regex(TEXT_PATTERNS[field.pattern], `validation.text.${field.pattern}`);
    case 'secret':
      return z
        .string()
        .min(CATALOG_LIMITS.secretMin, 'validation.secretTooShort')
        .max(CATALOG_LIMITS.secretMax, 'validation.secretTooLong')
        .regex(SECRET_PATTERN, 'validation.secretInvalid');
    case 'enum':
      return z.enum(field.options as [string, ...string[]], 'validation.optionInvalid');
    case 'boolean':
      return z.boolean();
  }
}

/** The form's starting values: each user field's default (empty for a secret or a text without one). */
export function defaultValues(meta: CatalogMeta): FieldValues {
  const values: FieldValues = {};
  for (const field of meta.fields) {
    if (!isUserField(field)) continue;
    values[field.key] = 'default' in field && field.default !== undefined ? field.default : '';
  }
  return values;
}
