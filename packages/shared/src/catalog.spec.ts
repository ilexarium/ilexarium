import { describe, expect, it } from 'vitest';
import {
  CATALOG_PATH,
  catalogEntryPath,
  catalogIconPath,
  catalogMetaSchema,
  defaultValues,
  isPlainAbsolutePath,
  templatePlaceholders,
  TEXT_PATTERNS,
  type CatalogMeta,
  valuesSchema,
} from './catalog.js';

const meta: CatalogMeta = {
  schemaVersion: 1,
  id: 'demo',
  version: '1',
  name: 'Demo',
  category: 'tools',
  website: 'https://example.org',
  webPort: 'WEB_PORT',
  dataOwner: { uid: 1000, gid: 1000 },
  fields: [
    { key: 'WEB_PORT', type: 'port', default: 8080 },
    { key: 'DATA_DIR', type: 'path', default: '/srv/laris/demo/data', access: 'write' },
    { key: 'ADMIN_USER', type: 'text', pattern: 'username', default: 'admin' },
    { key: 'ADMIN_PASSWORD', type: 'secret' },
    { key: 'DB_PASSWORD', type: 'generatedSecret' },
    { key: 'LOG_LEVEL', type: 'enum', options: ['info', 'debug'], default: 'info', advanced: true },
    { key: 'TELEMETRY', type: 'boolean', default: false, advanced: true },
  ],
};

const good = {
  WEB_PORT: 8080,
  DATA_DIR: '/srv/laris/demo/data',
  ADMIN_USER: 'alice',
  ADMIN_PASSWORD: 'correct horse battery',
  LOG_LEVEL: 'debug',
  TELEMETRY: true,
};

/** The first message key of a failed parse, by field (what the form shows). */
function errors(values: unknown, options?: Parameters<typeof valuesSchema>[1]) {
  const result = valuesSchema(meta, options).safeParse(values);
  const first: Record<string, string> = {};
  for (const issue of result.error?.issues ?? []) first[issue.path.join('.')] ??= issue.message;
  return first;
}

describe('catalogMetaSchema', () => {
  it('accepts a complete entry', () => {
    expect(catalogMetaSchema.parse(meta)).toEqual(meta);
  });

  it('accepts an entry without a web page of its own (no Open link)', () => {
    const { webPort: _, ...withoutWeb } = meta;
    expect(catalogMetaSchema.safeParse(withoutWeb).success).toBe(true);
  });

  it.each([
    ['an id that could leave a folder', { id: '../etc' }],
    ['an uppercase id', { id: 'Demo' }],
    ['an http website', { website: 'http://example.org' }],
    ['a webPort that is not a port field', { webPort: 'DATA_DIR' }],
    ['a webPort that does not exist', { webPort: 'NOPE' }],
    ['an unknown property', { extra: true }],
    ['a newer schema version', { schemaVersion: 2 }],
  ])('refuses %s', (_, change) => {
    expect(catalogMetaSchema.safeParse({ ...meta, ...change }).success).toBe(false);
  });

  it.each([
    ['duplicate keys', [meta.fields[0], { ...meta.fields[0] }]],
    ['a lowercase key', [{ ...meta.fields[0], key: 'web_port' }]],
    ['a port default below 1024', [{ ...meta.fields[0], default: 80 }]],
    [
      'a relative path default',
      [meta.fields[0], { key: 'D', type: 'path', default: 'data', access: 'read' }],
    ],
    [
      'a path default with ".."',
      [meta.fields[0], { key: 'D', type: 'path', default: '/srv/../etc', access: 'read' }],
    ],
    ['a path without access', [meta.fields[0], { key: 'D', type: 'path', default: '/srv/x' }]],
    [
      'an enum default that is not an option',
      [meta.fields[0], { key: 'E', type: 'enum', options: ['a', 'b'], default: 'c' }],
    ],
    [
      'an enum option with spaces',
      [meta.fields[0], { key: 'E', type: 'enum', options: ['a b', 'c'], default: 'c' }],
    ],
    [
      'a text field with a free regular expression',
      [meta.fields[0], { key: 'T', type: 'text', pattern: '^.*$' }],
    ],
    [
      'a text default that breaks its pattern',
      [meta.fields[0], { key: 'T', type: 'text', pattern: 'username', default: 'Bob!' }],
    ],
    ['a secret with a default', [meta.fields[0], { key: 'S', type: 'secret', default: 'x' }]],
    ['an unknown field type', [meta.fields[0], { key: 'X', type: 'command', default: 'ls' }]],
  ])('refuses fields with %s', (_, fields) => {
    expect(catalogMetaSchema.safeParse({ ...meta, fields }).success).toBe(false);
  });
});

describe('catalogMetaSchema backup', () => {
  const backup = {
    folders: [{ field: 'DATA_DIR', skip: ['cache', 'thumbs', '.trash', 'a b', 'ü'] }],
    mode: 'stop',
    restoreNote: true,
  };

  it('accepts folder fields with plain skip names', () => {
    expect(catalogMetaSchema.safeParse({ ...meta, backup }).success).toBe(true);
    const live = { folders: [{ field: 'DATA_DIR' }], mode: 'live' };
    expect(catalogMetaSchema.safeParse({ ...meta, backup: live }).success).toBe(true);
  });

  it.each([
    ['no folders', { ...backup, folders: [] }],
    ['a field that does not exist', { ...backup, folders: [{ field: 'NOPE' }] }],
    ['a field that is not a folder', { ...backup, folders: [{ field: 'WEB_PORT' }] }],
    ['a folder twice', { ...backup, folders: [{ field: 'DATA_DIR' }, { field: 'DATA_DIR' }] }],
    ['an unknown mode', { ...backup, mode: 'snapshot' }],
    ['an unknown property', { ...backup, hooks: ['pg_dump'] }],
    ['a skip twice', { ...backup, folders: [{ field: 'DATA_DIR', skip: ['a', 'a'] }] }],
  ])('refuses %s', (_, change) => {
    expect(catalogMetaSchema.safeParse({ ...meta, backup: change }).success).toBe(false);
  });

  it.each([
    '',
    '.',
    '..',
    'a/b',
    '/etc',
    '../x',
    '-x',
    '--exclude',
    '*',
    'a?',
    '[ab]',
    'a\\b',
    'a\nb',
  ])('refuses the skip %j', (skip) => {
    const folders = [{ field: 'DATA_DIR', skip: [skip] }];
    expect(catalogMetaSchema.safeParse({ ...meta, backup: { ...backup, folders } }).success).toBe(
      false,
    );
  });
});

describe('valuesSchema', () => {
  it('accepts good values, and nothing for the generated secret', () => {
    expect(valuesSchema(meta).parse(good)).toEqual(good);
  });

  it('refuses unknown and missing fields — and a value for the generated secret', () => {
    expect(valuesSchema(meta).safeParse({ ...good, EXTRA: 'x' }).success).toBe(false);
    expect(valuesSchema(meta).safeParse({ ...good, DB_PASSWORD: 'mine' }).success).toBe(false);
    const { WEB_PORT: _, ...missing } = good;
    expect(valuesSchema(meta).safeParse(missing).success).toBe(false);
  });

  it('checks ports', () => {
    expect(errors({ ...good, WEB_PORT: 80 })).toEqual({ WEB_PORT: 'validation.portRange' });
    expect(errors({ ...good, WEB_PORT: 65536 })).toEqual({ WEB_PORT: 'validation.portRange' });
    expect(errors({ ...good, WEB_PORT: 8080.5 })).toEqual({ WEB_PORT: 'validation.portInvalid' });
    expect(errors({ ...good, WEB_PORT: '8080' })).toEqual({ WEB_PORT: 'validation.portInvalid' });
  });

  it.each([
    'relative/path',
    '/srv/../etc',
    '/srv/./x',
    '/srv//x',
    '/srv/x/',
    '/srv/x:/etc',
    '/srv/a,b',
    '/srv/a\nb',
    '/' + 'a'.repeat(1024),
  ])('refuses the folder %j', (path) => {
    expect(errors({ ...good, DATA_DIR: path })).toEqual({ DATA_DIR: 'validation.pathInvalid' });
  });

  it('checks texts by their named pattern', () => {
    expect(errors({ ...good, ADMIN_USER: 'Alice' })).toEqual({
      ADMIN_USER: 'validation.text.username',
    });
    expect(errors({ ...good, ADMIN_USER: '' })).toEqual({ ADMIN_USER: 'validation.textRequired' });
  });

  it('checks secrets: length, one printable line', () => {
    expect(errors({ ...good, ADMIN_PASSWORD: 'short' })).toEqual({
      ADMIN_PASSWORD: 'validation.secretTooShort',
    });
    expect(errors({ ...good, ADMIN_PASSWORD: 'x'.repeat(129) })).toEqual({
      ADMIN_PASSWORD: 'validation.secretTooLong',
    });
    expect(errors({ ...good, ADMIN_PASSWORD: 'long enough\npassword' })).toEqual({
      ADMIN_PASSWORD: 'validation.secretInvalid',
    });
    // Any printable character is fine, including spaces, quotes and "$".
    expect(errors({ ...good, ADMIN_PASSWORD: ` p@$$ "w0rd' ${'$'}{X} ü ` })).toEqual({});
  });

  it('keeps a previous install’s secret when left empty, only if asked to', () => {
    expect(errors({ ...good, ADMIN_PASSWORD: '' })).toEqual({
      ADMIN_PASSWORD: 'validation.secretTooShort',
    });
    expect(errors({ ...good, ADMIN_PASSWORD: '' }, { keptSecrets: ['ADMIN_PASSWORD'] })).toEqual(
      {},
    );
  });

  it('checks options and booleans', () => {
    expect(errors({ ...good, LOG_LEVEL: 'trace' })).toEqual({
      LOG_LEVEL: 'validation.optionInvalid',
    });
    expect(valuesSchema(meta).safeParse({ ...good, TELEMETRY: 'yes' }).success).toBe(false);
  });
});

describe('TEXT_PATTERNS.timezone', () => {
  it('accepts IANA names and refuses anything else', () => {
    for (const tz of ['UTC', 'Europe/Berlin', 'America/Argentina/Buenos_Aires', 'Etc/GMT+1']) {
      expect(TEXT_PATTERNS.timezone.test(tz), tz).toBe(true);
    }
    for (const tz of ['', '/etc/localtime', '../x', 'Europe/', 'a b', 'Europe/Berlin\n']) {
      expect(TEXT_PATTERNS.timezone.test(tz), JSON.stringify(tz)).toBe(false);
    }
  });
});

describe('isPlainAbsolutePath', () => {
  it('accepts plain absolute paths', () => {
    for (const path of ['/', '/srv', '/srv/laris/demo', '/mnt/My Disk/Music']) {
      expect(isPlainAbsolutePath(path), path).toBe(true);
    }
  });
});

describe('templatePlaceholders', () => {
  it('lists each ${KEY} once, ignoring $$ escapes and other text', () => {
    const template = 'ports: ["${WEB_PORT}:80"]\nx: ${DATA_DIR}\ny: ${WEB_PORT}\nz: $$HOME $lower';
    expect(templatePlaceholders(template)).toEqual(['WEB_PORT', 'DATA_DIR']);
  });
});

describe('defaultValues', () => {
  it('starts each user field at its default, empty without one', () => {
    expect(defaultValues(meta)).toEqual({
      WEB_PORT: 8080,
      DATA_DIR: '/srv/laris/demo/data',
      ADMIN_USER: 'admin',
      ADMIN_PASSWORD: '',
      LOG_LEVEL: 'info',
      TELEMETRY: false,
    });
  });
});

describe('catalog paths', () => {
  it('put the encoded id in the path', () => {
    expect(CATALOG_PATH).toBe('/api/catalog');
    expect(catalogEntryPath('immich')).toBe('/api/catalog/immich');
    expect(catalogIconPath('immich')).toBe('/api/catalog/immich/icon');
    expect(catalogEntryPath('a/../b')).toBe('/api/catalog/a%2F..%2Fb');
  });
});
