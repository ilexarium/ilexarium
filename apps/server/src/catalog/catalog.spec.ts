import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import en from '@homelab/i18n/en.json' with { type: 'json' };
import type { CatalogMeta } from '@homelab/shared';
import { flattenMessages } from '@homelab/i18n';
import { CatalogError, loadCatalog } from './catalog-loader.js';
import { checkComposePolicy, checkPlaceholders } from './compose-policy.js';

const CATALOG_DIR = fileURLToPath(new URL('../../../../catalog', import.meta.url));
const DIGEST = `@sha256:${'a'.repeat(64)}`;

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
    { key: 'MEDIA_DIR', type: 'path', default: '/srv/homelab/demo/media', access: 'read' },
    { key: 'DATA_DIR', type: 'path', default: '/srv/homelab/demo/data', access: 'write' },
  ],
};

/** A recipe that passes every rule; each bad case changes one thing. */
function goodTemplate(): Record<string, any> {
  return {
    services: {
      app: {
        image: `example/app:1.0${DIGEST}`,
        ports: ['${WEB_PORT}:80'],
        volumes: [
          { type: 'bind', source: '${MEDIA_DIR}', target: '/media', read_only: true },
          { type: 'bind', source: '${DATA_DIR}', target: '/data' },
          'cache:/cache',
        ],
        depends_on: ['db'],
        restart: 'unless-stopped',
        logging: { driver: 'json-file', options: { 'max-size': '10m' } },
      },
      db: {
        image: `postgres:18${DIGEST}`,
        volumes: [{ type: 'volume', source: 'db', target: '/var/lib/postgresql' }],
        restart: 'unless-stopped',
        logging: { driver: 'local', options: { 'max-size': '10m' } },
      },
    },
    volumes: { cache: null, db: {} },
  };
}

function withChange(change: (template: Record<string, any>) => void) {
  const template = goodTemplate();
  change(template);
  return checkComposePolicy(template, meta);
}

describe('the catalog', () => {
  it('loads every entry, each passing every rule', async () => {
    const entries = await loadCatalog(CATALOG_DIR);
    expect(entries.map((entry) => entry.meta.id)).toEqual(['immich', 'navidrome', 'ollama']);
    const immich = entries.find((entry) => entry.meta.id === 'immich')!;
    expect(immich.volumes).toEqual(['model-cache', 'database']);
    expect(immich.images).toHaveLength(4);
  });

  it("publishes Ollama's API on loopback only and has no Open link (it has no sign-in)", async () => {
    const entries = await loadCatalog(CATALOG_DIR);
    const ollama = entries.find((entry) => entry.meta.id === 'ollama')!;
    const recipe = await readFile(join(CATALOG_DIR, 'ollama', 'compose.yml'), 'utf8');
    expect(recipe).toMatch(/^\s+- '127\.0\.0\.1:\$\{API_PORT\}:11434'$/m);
    expect(recipe.match(/^\s+- '.*:11434'$/gm)).toHaveLength(1);
    expect(ollama.meta.webPort).toBeUndefined();
    expect(ollama.meta.backup).toBeUndefined();
  });

  it('has the texts of every entry in English (the consistency test covers the other languages)', async () => {
    const keys = new Set(Object.keys(flattenMessages(en)));
    for (const { meta: entry } of await loadCatalog(CATALOG_DIR)) {
      expect(keys.has(`catalog.${entry.id}.description`), entry.id).toBe(true);
      for (const field of entry.fields) {
        if (field.type === 'generatedSecret') continue;
        for (const part of ['label', 'help']) {
          const key = `catalog.${entry.id}.fields.${field.key}.${part}`;
          expect(keys.has(key), key).toBe(true);
        }
      }
      if (entry.backup?.restoreNote) {
        const key = `catalog.${entry.id}.backup.restoreNote`;
        expect(keys.has(key), key).toBe(true);
      }
    }
  });

  it('backs up Immich live without the folders it rebuilds, and stops Navidrome', async () => {
    const entries = await loadCatalog(CATALOG_DIR);
    const backup = (id: string) => entries.find((entry) => entry.meta.id === id)!.meta.backup;
    expect(backup('immich')).toEqual({
      folders: [{ field: 'UPLOAD_DIR', skip: ['thumbs', 'encoded-video'] }],
      mode: 'live',
      restoreNote: true,
    });
    expect(backup('navidrome')).toEqual({
      folders: [{ field: 'DATA_DIR' }, { field: 'MUSIC_DIR' }],
      mode: 'stop',
    });
  });
});

describe('checkComposePolicy', () => {
  it('accepts a good recipe', () => {
    expect(checkComposePolicy(goodTemplate(), meta)).toEqual([]);
  });

  it('accepts a port bound to loopback only (a service without its own sign-in)', () => {
    expect(withChange((t) => (t.services.app.ports = ['127.0.0.1:${WEB_PORT}:80']))).toEqual([]);
  });

  // One deliberately bad recipe per rule: each must be refused.
  it.each<[string, (t: Record<string, any>) => void, RegExp]>([
    ['privileged', (t) => (t.services.app.privileged = true), /privileged: not allowed/],
    ['cap_add', (t) => (t.services.app.cap_add = ['SYS_ADMIN']), /cap_add: not allowed/],
    ['devices', (t) => (t.services.app.devices = ['/dev/sda']), /devices: not allowed/],
    ['host network', (t) => (t.services.app.network_mode = 'host'), /network_mode: not allowed/],
    ['host pid', (t) => (t.services.app.pid = 'host'), /pid: not allowed/],
    ['host ipc', (t) => (t.services.app.ipc = 'host'), /ipc: not allowed/],
    ['userns_mode', (t) => (t.services.app.userns_mode = 'host'), /userns_mode: not allowed/],
    [
      'security_opt',
      (t) => (t.services.app.security_opt = ['seccomp:unconfined']),
      /security_opt: not allowed/,
    ],
    ['sysctls', (t) => (t.services.app.sysctls = { 'net.x': 1 }), /sysctls: not allowed/],
    ['build', (t) => (t.services.app.build = '.'), /build: not allowed/],
    ['extends', (t) => (t.services.app.extends = { file: 'x.yml' }), /extends: not allowed/],
    ['env_file', (t) => (t.services.app.env_file = ['.env']), /env_file: not allowed/],
    ['volumes_from', (t) => (t.services.app.volumes_from = ['db']), /volumes_from: not allowed/],
    ['container_name', (t) => (t.services.app.container_name = 'x'), /container_name: not/],
    ['a runtime', (t) => (t.services.app.runtime = 'runc'), /runtime: not allowed/],
    ['include', (t) => (t.include = ['other.yml']), /include: top-level key not allowed/],
    ['a project name', (t) => (t.name = 'immich'), /name: top-level key not allowed/],
    ['networks', (t) => (t.networks = { x: { external: true } }), /networks: top-level/],
    ['file secrets', (t) => (t.secrets = { s: { file: '/etc/shadow' } }), /secrets: top-level/],
    ['an external volume', (t) => (t.volumes.db = { external: true }), /volumes.db: named/],
    [
      'a volume that binds a host folder',
      (t) => (t.volumes.db = { driver_opts: { type: 'none', o: 'bind', device: '/etc' } }),
      /volumes.db: named volumes take no options/,
    ],
    [
      'the Docker socket',
      (t) =>
        t.services.app.volumes.push({
          type: 'bind',
          source: '/var/run/docker.sock',
          target: '/var/run/docker.sock',
        }),
      /bind mount source must be exactly/,
    ],
    [
      'a host folder in short syntax',
      (t) => t.services.app.volumes.push('/:/host'),
      /short syntax only/,
    ],
    [
      'a field folder in short syntax',
      (t) => (t.services.app.volumes[0] = '${MEDIA_DIR}:/media:ro'),
      /short syntax only/,
    ],
    [
      'a read folder mounted writable',
      (t) => delete t.services.app.volumes[0].read_only,
      /MEDIA_DIR is read-only/,
    ],
    [
      'bind propagation options',
      (t) => (t.services.app.volumes[1].bind = { propagation: 'shared' }),
      /volumes\[1\]\.bind: not allowed/,
    ],
    [
      'a volume not declared in the file',
      (t) => (t.services.db.volumes[0].source = 'other'),
      /not a volume declared/,
    ],
    ['a fixed host port', (t) => (t.services.app.ports = ['80:80']), /only '\$\{PORT_FIELD\}/],
    [
      'a host address on a port',
      (t) => (t.services.app.ports = ['0.0.0.0:${WEB_PORT}:80']),
      /only '\$\{PORT_FIELD\}/,
    ],
    [
      'a host address other than loopback',
      (t) => (t.services.app.ports = ['192.168.1.10:${WEB_PORT}:80']),
      /only '\$\{PORT_FIELD\}/,
    ],
    [
      'loopback written another way',
      (t) => (t.services.app.ports = ['127.0.0.2:${WEB_PORT}:80']),
      /only '\$\{PORT_FIELD\}/,
    ],
    [
      'a port in long syntax',
      (t) => (t.services.app.ports = [{ target: 80, published: '${WEB_PORT}' }]),
      /only '\$\{PORT_FIELD\}/,
    ],
    ['ports not as a list', (t) => (t.services.app.ports = { a: 1 }), /ports: must be a list/],
    ['an image without a digest', (t) => (t.services.app.image = 'example/app:1.0'), /pinned/],
    ['another restart policy', (t) => (t.services.app.restart = 'always'), /unless-stopped/],
    ['no log rotation', (t) => delete t.services.app.logging, /logging: json-file or local/],
    [
      'a protected label',
      (t) => (t.services.app.labels = { 'homelab.protected': 'true' }),
      /reserved label/,
    ],
    [
      'a Compose project label (posing as another project)',
      (t) => (t.services.app.labels = ['com.docker.compose.project=hl-immich']),
      /reserved label/,
    ],
    ['an unknown dependency', (t) => (t.services.app.depends_on = ['x']), /unknown service x/],
    [
      'a port field never published',
      (t) => (t.services.app.ports = []),
      /WEB_PORT: port field never published/,
    ],
    [
      'a folder field never mounted',
      (t) => t.services.app.volumes.splice(1, 1),
      /DATA_DIR: folder never mounted/,
    ],
  ])('refuses %s', (_, change, expected) => {
    const problems = withChange(change);
    expect(
      problems.some((problem) => expected.test(problem)),
      problems.join('\n'),
    ).toBe(true);
  });
});

describe('checkPlaceholders', () => {
  const ok = 'a: ${WEB_PORT}\nb: ${MEDIA_DIR}\nc: ${DATA_DIR}\nd: $$literal';

  it('accepts declared ${KEY}s and $$', () => {
    expect(checkPlaceholders(ok, meta)).toEqual([]);
  });

  it.each([
    ['an undeclared key', `${ok}\ne: \${HOME_DIR}`, /HOME_DIR\}: not a declared field/],
    ['a default', `${ok}\ne: \${WEB_PORT:-80}`, /only \$\{KEY\}/],
    ['a bare $NAME', `${ok}\ne: $HOME`, /only \$\{KEY\}/],
    ['a lowercase key', `${ok}\ne: \${home}`, /only \$\{KEY\}/],
    ['a field never used', 'a: ${WEB_PORT}\nb: ${MEDIA_DIR}', /DATA_DIR: declared but never used/],
  ])('refuses %s', (_, text, expected) => {
    const problems = checkPlaceholders(text, meta);
    expect(
      problems.some((problem) => expected.test(problem)),
      problems.join('\n'),
    ).toBe(true);
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
      'meta.json': JSON.stringify({ ...meta, id }),
      'compose.yml': JSON.stringify(goodTemplate()), // JSON is YAML
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

  it('loads a good entry', async () => {
    await writeEntry('demo', {});
    const [entry] = await loadCatalog(dir);
    expect(entry.meta.id).toBe('demo');
    expect(entry.volumes).toEqual(['cache', 'db']);
  });

  it('names every problem of every entry', async () => {
    await writeEntry('a', { 'meta.json': JSON.stringify({ ...meta, id: 'b' }) });
    await writeEntry('c', { 'icon.svg': '<svg onload="alert(1)"></svg>' });
    await writeEntry('d', { 'meta.json': JSON.stringify({ ...meta, id: 'd', website: 'x' }) });
    await mkdir(join(dir, 'Bad_Name'));
    const problems = await problemsOf();
    expect(problems).toEqual([
      'a: meta.json id "b" is not the folder\'s name',
      'Bad_Name: not a valid catalog id',
      expect.stringMatching(/^c: icon\.svg must be a plain SVG/),
      expect.stringMatching(/^d: meta\.json website/),
    ]);
  });

  it('refuses YAML alias bombs', async () => {
    const lines = ['a: &a ["x","x","x","x","x","x","x","x","x","x"]'];
    for (let i = 1; i < 12; i++)
      lines.push(
        `${'a'.repeat(i + 1)}: &${'a'.repeat(i + 1)} [*${'a'.repeat(i)},*${'a'.repeat(i)},*${'a'.repeat(i)},*${'a'.repeat(i)},*${'a'.repeat(i)},*${'a'.repeat(i)},*${'a'.repeat(i)},*${'a'.repeat(i)},*${'a'.repeat(i)},*${'a'.repeat(i)}]`,
      );
    await writeEntry('bomb', { 'compose.yml': lines.join('\n') });
    const problems = await problemsOf();
    expect(problems.join('\n')).toMatch(/bomb: .*alias/i);
  });
});
