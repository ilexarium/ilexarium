import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CATALOG_ID_PATTERN, catalogMetaSchema } from '@homelab/shared';
import { parse } from 'yaml';
import { checkComposePolicy, checkPlaceholders } from './compose-policy.js';
import type { CatalogEntry } from './catalog.model.js';

const MAX_FILE_BYTES = 256 * 1024;
const MAX_ICON_BYTES = 64 * 1024;
/** What an icon must not contain, though it is only ever shown through <img> (where nothing runs). */
const UNSAFE_SVG = /<script|<foreignObject|\son[a-z]+\s*=|href\s*=|url\(|<!ENTITY/i;

/** Why the catalog can't be used: every problem in every entry, so one run shows them all. */
export class CatalogError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid catalog:\n  ${problems.join('\n  ')}`);
    this.name = 'CatalogError';
  }
}

/**
 * Loads every entry under `dir` (one folder per entry) and checks it completely: the meta
 * schema, placeholders, the Compose policy, the icon. Throws `CatalogError` listing every problem
 * — the server refuses to start on a bad catalog.
 */
export async function loadCatalog(dir: string): Promise<CatalogEntry[]> {
  const problems: string[] = [];
  const entries: CatalogEntry[] = [];
  const folders = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory());
  for (const folder of folders.sort((a, b) => a.name.localeCompare(b.name))) {
    const id = folder.name;
    if (!CATALOG_ID_PATTERN.test(id)) {
      problems.push(`${id}: not a valid catalog id`);
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
  const parsed = catalogMetaSchema.safeParse(JSON.parse(await readText(folder, 'meta.json')));
  if (!parsed.success) {
    problems.push(
      ...parsed.error.issues.map((i) => `meta.json ${i.path.join('.') || '(root)'}: ${i.message}`),
    );
    return null;
  }
  const meta = parsed.data;
  if (meta.id !== id) problems.push(`meta.json id "${meta.id}" is not the folder's name`);

  const templateText = await readText(folder, 'compose.yml');
  problems.push(...checkPlaceholders(templateText, meta).map((p) => `compose.yml ${p}`));
  // No merge keys or custom tags; aliases (YAML anchors) are resolved, but only so many.
  const template: unknown = parse(templateText, { maxAliasCount: 100, uniqueKeys: true });
  problems.push(...checkComposePolicy(template, meta).map((p) => `compose.yml ${p}`));

  const icon = await readFile(join(folder, 'icon.svg'));
  const svg = icon.toString('utf8');
  if (icon.length > MAX_ICON_BYTES || !/^\s*<svg[\s>]/.test(svg) || UNSAFE_SVG.test(svg)) {
    problems.push(
      'icon.svg must be a plain SVG under 64 KB (no scripts, events, links or entities)',
    );
  }
  if (problems.length > 0) return null;

  const services = (template as { services: Record<string, { image: string }> }).services;
  const volumes = (template as { volumes?: Record<string, unknown> }).volumes ?? {};
  return {
    meta,
    images: Object.values(services).map((service) => service.image),
    volumes: Object.keys(volumes),
    icon,
  };
}

async function readText(folder: string, name: string): Promise<string> {
  const content = await readFile(join(folder, name));
  if (content.length > MAX_FILE_BYTES) throw new Error(`${name} is larger than 256 KB`);
  return content.toString('utf8');
}
