import { describe, expect, it } from 'vitest';
import {
  CATALOG_PATH,
  catalogEntryPath,
  catalogIconPath,
  isPlainAbsolutePath,
  RELATIVE_PATH_PATTERN,
  type Template,
  templatePlaceholders,
  templateSchema,
} from './catalog.js';

const template: Template = {
  id: 'demo',
  version: '1',
  name: 'Demo',
  category: 'tools',
  website: 'https://example.org',
  web: { port: 8080 },
  fields: [
    { key: 'WEB_PORT', kind: 'port', default: 8080 },
    { key: 'DATA_DIR', kind: 'folder', default: './data' },
    { key: 'DEMO_VERSION', kind: 'version', default: '1.2' },
    { key: 'DB_PASSWORD', kind: 'generated' },
    { key: 'USER_ID', kind: 'text', default: '@account', advanced: true },
  ],
  backup: { mode: 'stop', skip: ['data/cache'], restoreNote: true },
  note: true,
};

const refused = (change: (t: Record<string, unknown>) => void) => {
  const copy = structuredClone(template) as unknown as Record<string, unknown>;
  change(copy);
  return !templateSchema.safeParse(copy).success;
};

describe('templateSchema', () => {
  it('accepts a complete template, and one without a web page or backup', () => {
    expect(templateSchema.parse(template)).toEqual(template);
    const { web: _, backup: __, ...plain } = template;
    expect(templateSchema.safeParse(plain).success).toBe(true);
  });

  it.each([
    ['an id that could leave a folder', (t: Record<string, unknown>) => (t['id'] = '../x')],
    ['an uppercase id', (t: Record<string, unknown>) => (t['id'] = 'Demo')],
    ['an http website', (t: Record<string, unknown>) => (t['website'] = 'http://example.org')],
    ['an unknown property', (t: Record<string, unknown>) => (t['extra'] = true)],
    ['a web port out of range', (t: Record<string, unknown>) => (t['web'] = { port: 70000 })],
    ['a version that is not a number', (t: Record<string, unknown>) => (t['version'] = 'v1')],
    [
      'duplicate keys',
      (t: Record<string, unknown>) =>
        (t['fields'] = [
          { key: 'A', kind: 'text' },
          { key: 'A', kind: 'port' },
        ]),
    ],
    [
      'a lowercase key',
      (t: Record<string, unknown>) => (t['fields'] = [{ key: 'a', kind: 'text' }]),
    ],
    [
      'an unknown kind',
      (t: Record<string, unknown>) => (t['fields'] = [{ key: 'A', kind: 'enum' }]),
    ],
    [
      'a field setting it doesn’t know',
      (t: Record<string, unknown>) => (t['fields'] = [{ key: 'V', kind: 'version', image: 'x/y' }]),
    ],
    ['an unknown backup mode', (t: Record<string, unknown>) => (t['backup'] = { mode: 'pause' })],
    [
      'a skip that leaves the folder',
      (t: Record<string, unknown>) => (t['backup'] = { mode: 'stop', skip: ['../x'] }),
    ],
  ])('refuses %s', (_, change) => {
    expect(refused(change)).toBe(true);
  });
});

describe('RELATIVE_PATH_PATTERN (skips)', () => {
  it.each(['data/cache', 'thumbs', '*.tmp', 'a/.hidden', 'library/encoded-video'])(
    'accepts %s',
    (path) => expect(RELATIVE_PATH_PATTERN.test(path)).toBe(true),
  );
  it.each(['', '..', 'a/../b', '-x', '/etc', 'a//b', 'a/', '[ab]', 'a\\b', 'a\nb'])(
    'refuses %j',
    (path) => expect(RELATIVE_PATH_PATTERN.test(path)).toBe(false),
  );
});

describe('templatePlaceholders', () => {
  it('finds every variable once, in order, with defaults and errors, never $$', () => {
    expect(templatePlaceholders('${A} ${B:-x} ${A} $${NOT} ${C:?needed} ${d_1}')).toEqual([
      'A',
      'B',
      'C',
      'd_1',
    ]);
  });
});

describe('isPlainAbsolutePath', () => {
  it.each(['/', '/srv', '/home/anna/apps/x', '/mnt/a b'])('accepts %s', (path) =>
    expect(isPlainAbsolutePath(path)).toBe(true),
  );
  it.each(['relative', '/srv/../etc', '/srv/./x', '/srv//x', '/srv/x/', '/srv/a\nb'])(
    'refuses %j',
    (path) => expect(isPlainAbsolutePath(path)).toBe(false),
  );
});

describe('catalog paths', () => {
  it('encodes ids', () => {
    expect(CATALOG_PATH).toBe('/api/catalog');
    expect(catalogEntryPath('a b')).toBe('/api/catalog/a%20b');
    expect(catalogIconPath('immich')).toBe('/api/catalog/immich/icon');
  });
});
