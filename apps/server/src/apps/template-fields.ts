import { randomBytes } from 'node:crypto';
import { type AppField, CATALOG_LIMITS, parseEnv, type Template } from '@laris/shared';
import type { FieldContext } from './apps.model.js';

/** A random secret (letters, digits, "-" and "_": written bare in `.env`). */
export const generateSecret = () =>
  randomBytes(Math.ceil((CATALOG_LIMITS.generatedSecretLength * 3) / 4))
    .toString('base64url')
    .slice(0, CATALOG_LIMITS.generatedSecretLength);

/** A template's default, its tokens filled in: `@account` (uid:gid), `@timezone`. */
function filled(value: string | number | undefined, context: FieldContext): string | null {
  if (value === undefined) return null;
  if (value === '@account') return context.account;
  if (value === '@timezone') return context.timezone;
  return String(value);
}

/**
 * A template's setup form: its fields, each value from `.env`, else its default, else a new
 * secret for a `generated` one. A kind is a hint for the form; plain text always works.
 */
export function templateFields(template: Template, env: string, context: FieldContext): AppField[] {
  const values = parseEnv(env);
  return template.fields.map((field) => {
    const fallback = filled(field.default, context);
    return {
      key: field.key,
      kind: field.kind,
      value:
        values.get(field.key) ?? (field.kind === 'generated' ? generateSecret() : (fallback ?? '')),
      default: fallback,
      required: fallback === null,
      advanced: field.advanced ?? false,
    };
  });
}
