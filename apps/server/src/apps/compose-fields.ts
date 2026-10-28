import { randomBytes } from 'node:crypto';
import {
  type AppField,
  type AppFields,
  type AppImage,
  CATALOG_LIMITS,
  type FieldKind,
  parseEnv,
  type Template,
} from '@laris/shared';
import { parse } from 'yaml';
import { SECRET_NAME, KIND_RANK } from './apps.constants.js';
import type { FieldContext } from './apps.model.js';

/** One variable as a Compose file uses it. */
interface Use {
  key: string;
  kind: FieldKind;
  default: string | null;
  required: boolean;
}

/**
 * The variables of a text as Compose reads them: `${KEY}`, `${KEY:-default}`, `${KEY-default}`,
 * `${KEY:?error}`, `${KEY?error}`, `${KEY:+other}`, `$KEY`; `$$` is a plain `$`. Each with where
 * it starts, so a caller can tell which part of a value it's in.
 */
export function variablesIn(text: string): (Omit<Use, 'kind'> & { at: number; end: number })[] {
  const found: (Omit<Use, 'kind'> & { at: number; end: number })[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '$') continue;
    const next = text[i + 1];
    if (next === '$') {
      i++;
      continue;
    }
    if (next === '{') {
      let depth = 1;
      let end = i + 2;
      for (; end < text.length && depth > 0; end++) {
        if (text[end] === '{') depth++;
        else if (text[end] === '}') depth--;
      }
      const inner = text.slice(i + 2, end - 1);
      const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+])([\s\S]*))?$/.exec(inner);
      if (match) {
        const [, key, operator, rest] = match;
        found.push({
          key,
          default: operator === ':-' || operator === '-' ? rest : null,
          required: operator === ':?' || operator === '?',
          at: i,
          end,
        });
      }
      i = end - 1;
      continue;
    }
    const bare = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i + 1));
    if (bare) {
      found.push({ key: bare[0], default: null, required: false, at: i, end: i + 1 + bare[0].length });
      i += bare[0].length;
    }
  }
  return found;
}

/** The kind of what a variable is by its name alone. */
const byName = (key: string): FieldKind => (SECRET_NAME.test(key) ? 'secret' : 'text');

/** A short `ports:` entry: `[ip:]host[-range]:container[/proto]` — which part each variable is in. */
function portUses(entry: string): Use[] {
  const vars = variablesIn(entry);
  // The separators outside of variables (an IPv6 address in brackets has its own colons).
  const colons: number[] = [];
  let bracket = false;
  for (let i = 0; i < entry.length; i++) {
    if (vars.some((v) => i >= v.at && i < v.end)) continue;
    if (entry[i] === '[') bracket = true;
    else if (entry[i] === ']') bracket = false;
    else if (entry[i] === ':' && !bracket) colons.push(i);
  }
  const ipEnd = colons.length >= 2 ? colons[0] : -1;
  return vars.map((v) => ({
    key: v.key,
    default: v.default,
    required: v.required,
    kind: v.at < ipEnd ? 'text' : 'port',
  }));
}

/** A short `volumes:` entry: `source:target[:mode]` — a variable in a path-like source is a folder. */
function volumeUses(entry: string): Use[] {
  const vars = variablesIn(entry);
  const colon = (() => {
    for (let i = 0; i < entry.length; i++) {
      if (entry[i] === ':' && !vars.some((v) => i >= v.at && i < v.end)) return i;
    }
    return -1;
  })();
  const source = colon < 0 ? '' : entry.slice(0, colon);
  // A named volume is a plain name; a bind mount starts with "/", ".", "~" or a variable.
  const bind = /^[/.~$]/.test(source);
  return vars.map((v) => ({
    key: v.key,
    default: v.default,
    required: v.required,
    kind: v.at < colon && bind ? 'folder' : byName(v.key),
  }));
}

/** An image reference's parts: the tag is after the last ":" that comes after the last "/". */
export function splitImage(reference: string): { image: string; tag: string | null; digest: string | null } {
  const [name, digest = null] = reference.split('@') as [string, string?];
  const slash = name.lastIndexOf('/');
  const colon = name.lastIndexOf(':');
  return colon > slash
    ? { image: name.slice(0, colon), tag: name.slice(colon + 1), digest }
    : { image: name, tag: null, digest };
}

function imageUses(reference: string): Use[] {
  const { image } = splitImage(reference);
  return variablesIn(reference).map((v) => ({
    key: v.key,
    default: v.default,
    required: v.required,
    kind: v.at >= image.length ? 'version' : byName(v.key),
  }));
}

function plainUses(text: string): Use[] {
  return variablesIn(text).map((v) => ({ ...v, kind: byName(v.key) }));
}

type Tree = unknown;

/** Every use in a parsed Compose file, judged by where it is. */
function usesIn(file: Tree): Use[] {
  const uses: Use[] = [];
  const walk = (value: Tree, path: string[]) => {
    if (typeof value === 'string') {
      const [top, , section, , field] = path;
      const service = top === 'services';
      if (service && section === 'ports' && field === undefined) {
        uses.push(...portUses(value));
      } else if (service && section === 'ports' && field !== 'host_ip') {
        uses.push(...plainUses(value).map((use) => ({ ...use, kind: 'port' as const })));
      } else if (service && section === 'volumes' && field === undefined) {
        uses.push(...volumeUses(value));
      } else if (service && section === 'volumes' && field === 'source') {
        const bind = /^[/.~$]/.test(value);
        uses.push(...plainUses(value).map((use) => (bind ? { ...use, kind: 'folder' as const } : use)));
      } else if (service && section === 'image' && path.length === 3) {
        uses.push(...imageUses(value));
      } else {
        uses.push(...plainUses(value));
      }
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, [...path, String(i)]));
    } else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) walk(item, [...path, key]);
    }
  };
  walk(file, []);
  return uses;
}

/** Every service's image line, for the versions list. */
function imagesIn(file: Tree): AppImage[] {
  const services = (file as { services?: Record<string, { image?: unknown }> } | null)?.services;
  if (!services || typeof services !== 'object') return [];
  const images: AppImage[] = [];
  for (const [service, definition] of Object.entries(services)) {
    const reference = definition?.image;
    if (typeof reference !== 'string') continue;
    const { image, tag } = splitImage(reference);
    const variable = tag ? (variablesIn(tag)[0]?.key ?? null) : null;
    images.push({
      service,
      image,
      tag: tag && !variable ? tag : null,
      variable,
    });
  }
  return images;
}

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
 * The setup form of a Compose file and its `.env`: one field per variable, its kind guessed from
 * where it's used (a template says it instead), its value from `.env`, else its default. Laris
 * never checks a value against its kind: it's a hint for the form, and plain text always works.
 */
export function composeFields(
  compose: string,
  env: string,
  template: Template | null,
  context: FieldContext,
): AppFields {
  let file: Tree;
  try {
    file = parse(compose, { maxAliasCount: 100, uniqueKeys: false, prettyErrors: false });
  } catch (error) {
    return { fields: [], images: [], problem: (error as Error).message.split('\n')[0] };
  }
  if (file !== null && (typeof file !== 'object' || Array.isArray(file))) {
    return { fields: [], images: [], problem: 'Not a Compose file' };
  }
  const values = parseEnv(env);
  const byKey = new Map<string, Use>();
  for (const use of usesIn(file)) {
    const seen = byKey.get(use.key);
    if (!seen) {
      byKey.set(use.key, { ...use });
      continue;
    }
    if (KIND_RANK[use.kind] > KIND_RANK[seen.kind]) seen.kind = use.kind;
    seen.default ??= use.default;
    seen.required ||= use.required;
  }
  const fields: AppField[] = [];
  const templateFields = template?.fields ?? [];
  for (const field of templateFields) {
    const use = byKey.get(field.key);
    byKey.delete(field.key);
    const fallback = filled(field.default, context) ?? use?.default ?? null;
    const value =
      values.get(field.key) ??
      (field.kind === 'generated' ? generateSecret() : (fallback ?? ''));
    fields.push({
      key: field.key,
      kind: field.kind,
      value,
      default: fallback,
      required: (use?.required ?? false) || fallback === null,
      advanced: field.advanced ?? false,
      image: field.image ?? null,
      fromTemplate: true,
    });
  }
  const images = imagesIn(file);
  for (const use of byKey.values()) {
    fields.push({
      key: use.key,
      kind: use.kind,
      value: values.get(use.key) ?? use.default ?? '',
      default: use.default,
      required: use.required,
      advanced: false,
      image:
        use.kind === 'version'
          ? (images.find((image) => image.variable === use.key)?.image ?? null)
          : null,
      fromTemplate: false,
    });
  }
  return { fields, images, problem: null };
}
