import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CATALOG_ID_PATTERN,
  TEMPLATE_LABEL,
  type Template,
  templatePlaceholders,
  templateSchema,
} from '@laris/shared';
import { parse } from 'yaml';
import {
  MAX_FILE_BYTES,
  MAX_ICON_BYTES,
  MOVING_TAGS,
  UNSAFE_SVG,
} from './catalog-loader.constants.js';
import type { CatalogEntry } from './catalog.model.js';

/** Why the catalog can't be used: every problem in every template, so one run shows them all. */
export class CatalogError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid catalog:\n  ${problems.join('\n  ')}`);
    this.name = 'CatalogError';
  }
}

/** Every problem in every template at once: the server refuses to start on a bad catalog. */
export async function loadCatalog(dir: string): Promise<CatalogEntry[]> {
  const problems: string[] = [];
  const entries: CatalogEntry[] = [];
  const folders = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory());
  for (const folder of folders.sort((a, b) => a.name.localeCompare(b.name))) {
    const id = folder.name;
    if (!CATALOG_ID_PATTERN.test(id)) {
      problems.push(`${id}: not a valid template id`);
      continue;
    }
    const entryProblems: string[] = [];
    const entry = await loadEntry(join(dir, id), id, entryProblems).catch((error: unknown) => {
      entryProblems.push((error as Error).message);
      return null;
    });
    problems.push(...entryProblems.map((problem) => `${id}: ${problem}`));
    if (entry && entryProblems.length === 0) entries.push(entry);
  }
  if (problems.length > 0) throw new CatalogError(problems);
  return entries;
}

async function loadEntry(
  folder: string,
  id: string,
  problems: string[],
): Promise<CatalogEntry | null> {
  const parsed = templateSchema.safeParse(JSON.parse(await readText(folder, 'template.json')));
  if (!parsed.success) {
    problems.push(
      ...parsed.error.issues.map(
        (i) => `template.json ${i.path.join('.') || '(root)'}: ${i.message}`,
      ),
    );
    return null;
  }
  const template = parsed.data;
  if (template.id !== id) problems.push(`template.json id "${template.id}" is not the folder's name`);
  const compose = await readText(folder, 'compose.yml');
  problems.push(...checkTemplate(template, compose).map((p) => `compose.yml ${p}`));

  const icon = await readFile(join(folder, 'icon.svg'));
  const svg = icon.toString('utf8');
  if (icon.length > MAX_ICON_BYTES || !/^\s*<svg[\s>]/.test(svg) || UNSAFE_SVG.test(svg)) {
    problems.push(
      'icon.svg must be a plain SVG under 64 KB (no scripts, events, links or entities)',
    );
  }
  return problems.length > 0 ? null : { template, compose, icon };
}

/**
 * Our own checks of a template (the person may change anything afterwards): every variable a
 * field and every field used; no moving tags; each service labelled with the template.
 */
export function checkTemplate(template: Template, compose: string): string[] {
  const problems: string[] = [];
  const used = templatePlaceholders(compose);
  const fields = template.fields.map((field) => field.key);
  for (const key of used) if (!fields.includes(key)) problems.push(`\${${key}} is not a field`);
  for (const key of fields) if (!used.includes(key)) problems.push(`field ${key} is not used`);
  let file: unknown;
  try {
    file = parse(compose, { maxAliasCount: 100, uniqueKeys: true });
  } catch (error) {
    return [...problems, `is not YAML: ${(error as Error).message}`];
  }
  const services = (file as { services?: Record<string, Record<string, unknown>> } | null)
    ?.services;
  if (!services || typeof services !== 'object' || Object.keys(services).length === 0) {
    return [...problems, 'has no services'];
  }
  const label = `${template.id}@${template.version}`;
  for (const [name, service] of Object.entries(services)) {
    const image = typeof service['image'] === 'string' ? service['image'] : '';
    const tag = /:([^/:@]+)(@|$)/.exec(image)?.[1];
    if (!tag) problems.push(`${name}: the image has no tag`);
    else if (MOVING_TAGS.test(tag)) problems.push(`${name}: the tag "${tag}" moves`);
    const labels = service['labels'];
    const value = Array.isArray(labels)
      ? labels.find((l) => typeof l === 'string' && l.startsWith(`${TEMPLATE_LABEL}=`))?.split('=')[1]
      : (labels as Record<string, unknown> | undefined)?.[TEMPLATE_LABEL];
    if (value !== label) problems.push(`${name}: needs the label ${TEMPLATE_LABEL}: ${label}`);
  }
  for (const field of template.fields) {
    if (field.kind === 'version' && MOVING_TAGS.test(String(field.default ?? ''))) {
      problems.push(`${field.key}: the default "${field.default}" moves`);
    }
  }
  return problems;
}

async function readText(folder: string, name: string): Promise<string> {
  const content = await readFile(join(folder, name));
  if (content.length > MAX_FILE_BYTES) throw new Error(`${name} is larger than 256 KB`);
  return content.toString('utf8');
}
