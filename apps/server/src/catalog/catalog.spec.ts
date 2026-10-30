import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import en from '@laris/i18n/en.json' with { type: 'json' };
import { TEMPLATE_LABEL, type Template, templatePlaceholders } from '@laris/shared';
import { flattenMessages } from '@laris/i18n';
import { parse } from 'yaml';
import { CatalogError, loadCatalog } from './catalog-loader.js';
import type { CatalogEntry } from './catalog.model.js';

const CATALOG_DIR = fileURLToPath(new URL('../../../../catalog', import.meta.url));

const MAX_ICON_BYTES = 64 * 1024;
/** What an icon must not contain, though it is only ever shown through <img> (where nothing runs). */
const UNSAFE_SVG = /<script|<foreignObject|\son[a-z]+\s*=|href\s*=|url\(|<!ENTITY/i;
/** Tags a template never uses: they change under the person without an update. */
const MOVING_TAGS = /^(latest|nightly|develop|dev|edge|main|master|release)$/i;

/**
 * A template's rules (catalog/README.md; the person may change anything afterwards): every
 * variable a field and every field used; no moving tags; each service labelled with the template.
 */
function checkTemplate(template: Template, compose: string): string[] {
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
      ? labels
          .find((l) => typeof l === 'string' && l.startsWith(`${TEMPLATE_LABEL}=`))
          ?.split('=')[1]
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

/** Only ever used in <img>, served with a no-script policy: still plain, small and inert. */
const iconSafe = (icon: Buffer) => {
  const svg = icon.toString('utf8');
  return icon.length <= MAX_ICON_BYTES && /^\s*<svg[\s>]/.test(svg) && !UNSAFE_SVG.test(svg);
};

const catalog: CatalogEntry[] = await loadCatalog(CATALOG_DIR);

const template: Template = {
  id: 'demo',
  version: '1',
  name: 'Demo',
  category: 'tools',
  website: 'https://example.org',
  web: { port: 80 },
  fields: [
    { key: 'WEB_PORT', kind: 'port', default: 8080 },
    { key: 'DATA_DIR', kind: 'folder', default: './data' },
    { key: 'DEMO_VERSION', kind: 'version', default: '1.2' },
  ],
};

const compose = `services:
  app:
    image: example/app:\${DEMO_VERSION}
    ports: ['\${WEB_PORT}:80']
    volumes: ['\${DATA_DIR}:/data']
    labels:
      laris.template: demo@1
  db:
    image: postgres:18
    labels: ['laris.template=demo@1']
`;

describe('the catalog', () => {
  it('loads every template', () => {
    expect(catalog.map((entry) => entry.template.id)).toEqual(['immich', 'navidrome', 'ollama']);
  });

  it.each(catalog.map((entry) => [entry.template.id, entry] as const))(
    '%s follows the rules: its variables, tags and labels; a plain icon',
    (_id, { template: entry, compose: file, icon }) => {
      expect(checkTemplate(entry, file)).toEqual([]);
      expect(iconSafe(icon)).toBe(true);
    },
  );

  it('puts Ollama’s API on 127.0.0.1 by default and gives it no Open link (it has no sign-in)', async () => {
    const entries = await loadCatalog(CATALOG_DIR);
    const ollama = entries.find((entry) => entry.template.id === 'ollama')!;
    expect(ollama.compose).toMatch(/'\$\{API_ADDRESS\}:\$\{API_PORT\}:11434'/);
    expect(ollama.template.fields.find((f) => f.key === 'API_ADDRESS')?.default).toBe('127.0.0.1');
    expect(ollama.template.web).toBeUndefined();
  });

  it('has the texts of every template in English (the consistency test covers the other languages)', async () => {
    const keys = new Set(Object.keys(flattenMessages(en)));
    for (const { template: entry } of await loadCatalog(CATALOG_DIR)) {
      expect(keys.has(`catalog.${entry.id}.description`), entry.id).toBe(true);
      for (const field of entry.fields) {
        for (const part of ['label', 'help']) {
          const key = `catalog.${entry.id}.fields.${field.key}.${part}`;
          expect(keys.has(key), key).toBe(true);
        }
      }
      if (entry.note) expect(keys.has(`catalog.${entry.id}.note`), entry.id).toBe(true);
      if (entry.backup?.restoreNote) {
        const key = `catalog.${entry.id}.backup.restoreNote`;
        expect(keys.has(key), key).toBe(true);
      }
    }
  });

  it('backs Immich up live without what it rebuilds, Navidrome stopped; Immich’s images share one version', async () => {
    const entries = await loadCatalog(CATALOG_DIR);
    const immich = entries.find((e) => e.template.id === 'immich')!;
    expect(immich.template.backup).toEqual({
      mode: 'live',
      skip: ['library/thumbs', 'library/encoded-video', 'model-cache', 'postgres'],
      restoreNote: true,
    });
    expect(immich.compose.match(/:\$\{IMMICH_VERSION\}/g)).toHaveLength(2);
    const navidrome = entries.find((e) => e.template.id === 'navidrome')!;
    expect(navidrome.template.backup?.mode).toBe('stop');
  });

  it('keeps the data in folders inside the app’s folder by default', async () => {
    for (const { template: entry } of await loadCatalog(CATALOG_DIR)) {
      for (const field of entry.fields.filter((f) => f.kind === 'folder')) {
        expect(String(field.default), `${entry.id} ${field.key}`).toMatch(/^\.\//);
      }
    }
  });
});

describe('the rules’ check', () => {
  it('accepts a good template', () => {
    expect(checkTemplate(template, compose)).toEqual([]);
  });

  it('names variables that are no field, and fields not used', () => {
    expect(checkTemplate(template, compose.replace('${DATA_DIR}', '${OTHER}'))).toEqual([
      '${OTHER} is not a field',
      'field DATA_DIR is not used',
    ]);
  });

  it('a plain SVG icon only', () => {
    expect(iconSafe(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe(true);
    expect(iconSafe(Buffer.from('<svg onload="alert(1)"></svg>'))).toBe(false);
    expect(iconSafe(Buffer.from('<svg><a href="https://x"/></svg>'))).toBe(false);
    expect(iconSafe(Buffer.from('<html></html>'))).toBe(false);
  });

  it('refuses moving tags and missing labels', () => {
    expect(checkTemplate(template, compose.replace('postgres:18', 'postgres:latest'))).toEqual([
      'db: the tag "latest" moves',
    ]);
    expect(checkTemplate(template, compose.replace('postgres:18', 'postgres'))).toEqual([
      'db: the image has no tag',
    ]);
    expect(checkTemplate(template, compose.replace("['laris.template=demo@1']", '[]'))).toEqual([
      'db: needs the label laris.template: demo@1',
    ]);
    const moving = {
      ...template,
      fields: template.fields.map((f) => (f.kind === 'version' ? { ...f, default: 'nightly' } : f)),
    };
    expect(checkTemplate(moving, compose)).toEqual(['DEMO_VERSION: the default "nightly" moves']);
  });
});

describe('loadCatalog', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'catalog-'));
  });

  afterEach(() => rm(dir, { recursive: true, force: true }));

  async function writeEntry(id: string, files: Partial<Record<string, string>>) {
    await mkdir(join(dir, id));
    const defaults = {
      'template.json': JSON.stringify({ ...template, id }),
      'compose.yml': compose.replaceAll('demo@1', `${id}@1`),
      'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>',
    };
    for (const [name, content] of Object.entries({ ...defaults, ...files })) {
      if (content !== undefined) await writeFile(join(dir, id, name), content);
    }
  }

  async function problemsOf(): Promise<string[]> {
    const error = await loadCatalog(dir).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CatalogError);
    return (error as CatalogError).problems;
  }

  it('loads a good template, its compose.yml as written (comments kept)', async () => {
    await writeEntry('demo', { 'compose.yml': `# mine\n${compose}` });
    const [entry] = await loadCatalog(dir);
    expect(entry.template.id).toBe('demo');
    expect(entry.compose.startsWith('# mine\n')).toBe(true);
  });

  it('names every problem of every template: its schema, its id', async () => {
    await writeEntry('a', { 'template.json': JSON.stringify({ ...template, id: 'b' }) });
    await writeEntry('d', {
      'template.json': JSON.stringify({ ...template, id: 'd', website: 'x' }),
    });
    await mkdir(join(dir, 'Bad_Name'));
    const problems = await problemsOf();
    expect(problems).toEqual([
      expect.stringMatching(/^a: template\.json id "b" is not the folder's name/),
      'Bad_Name: not a valid template id',
      expect.stringMatching(/^d: template\.json website/),
    ]);
  });
});
