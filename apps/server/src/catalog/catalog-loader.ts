import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CATALOG_ID_PATTERN, templateSchema } from '@laris/shared';
import { MAX_FILE_BYTES } from './catalog-loader.constants.js';
import type { CatalogEntry } from './catalog.model.js';

/** Why the catalog can't be used: every problem in every template, so one run shows them all. */
export class CatalogError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid catalog:\n  ${problems.join('\n  ')}`);
    this.name = 'CatalogError';
  }
}

/**
 * Every template, each matching `templateSchema` in a folder of its id: the server refuses to
 * start on a bad catalog (every problem at once). The rest of a template's rules are checked by
 * the catalog's tests (catalog.spec.ts), before a release.
 */
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
  if (template.id !== id) {
    problems.push(`template.json id "${template.id}" is not the folder's name`);
    return null;
  }
  const compose = await readText(folder, 'compose.yml');
  const icon = await readFile(join(folder, 'icon.svg'));
  return { template, compose, icon };
}

async function readText(folder: string, name: string): Promise<string> {
  const content = await readFile(join(folder, name));
  if (content.length > MAX_FILE_BYTES) throw new Error(`${name} is larger than 256 KB`);
  return content.toString('utf8');
}
