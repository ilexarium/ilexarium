// Tests for the root wrapper (laris-compose.mts) — run in development mode (not root), with a
// fake `docker` that records its arguments and environment. Run by the server's unit tests.
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WRAPPER = fileURLToPath(new URL('./laris-compose.mts', import.meta.url));
const SUDOERS = fileURLToPath(new URL('../sudoers/laris', import.meta.url));
const CATALOG = fileURLToPath(new URL('../../catalog', import.meta.url));
const REAL_DOCKER = ['/usr/bin/docker', '/usr/local/bin/docker'].find((p) => existsSync(p));
const DIGEST = `@sha256:${'a'.repeat(64)}`;

/**
 * Fake docker: appends `{ args, env }` to calls.jsonl beside itself. `config` prints config.json
 * (its ${KEY}s filled from the environment, like Compose) — or, if real-docker.txt exists, runs
 * the real docker for `config` only. Other commands print two lines (one looking like a marker),
 * then exit with exit-<command>.txt (default 0) after sleep-<command>.txt milliseconds.
 */
const FAKE_DOCKER = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const dir = __dirname;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ args, env: process.env, cwd: process.cwd() }) + '\\n');
const command = args.find((a) => ['config', 'pull', 'up', 'down'].includes(a));
const read = (name, fallback) => (fs.existsSync(path.join(dir, name)) ? fs.readFileSync(path.join(dir, name), 'utf8') : fallback);
if (command === 'config') {
  const real = read('real-docker.txt', '');
  if (real) {
    const result = require('node:child_process').spawnSync(real, args, { env: process.env });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  process.stdout.write(read('config.json', '{}').replace(/\\$\\{([A-Z0-9_]+)\\}/g, (_, k) => process.env[k] ?? ''));
  process.exit(0);
}
const ms = Number(read('sleep-' + command + '.txt', '0'));
if (ms) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
process.stdout.write(command + ' step 1\\n@@phase done\\n');
process.exit(Number(read('exit-' + command + '.txt', '0')));
`;

const meta = {
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
    { key: 'MEDIA_DIR', type: 'path', default: '/x', access: 'read' },
    { key: 'DATA_DIR', type: 'path', default: '/x', access: 'write' },
    { key: 'ADMIN_USER', type: 'text', pattern: 'username' },
    { key: 'ADMIN_PASSWORD', type: 'secret' },
    { key: 'DB_PASSWORD', type: 'generatedSecret' },
    { key: 'LOG_LEVEL', type: 'enum', options: ['info', 'debug'], default: 'info' },
    { key: 'TELEMETRY', type: 'boolean', default: false },
  ],
};

/** The normalised config `docker compose config --format json` would print for the demo. */
function demoConfig(): Record<string, any> {
  return {
    name: 'hl-demo',
    networks: { default: { name: 'hl-demo_default', ipam: {} } },
    services: {
      app: {
        image: `example/app:1${DIGEST}`,
        command: null,
        entrypoint: null,
        restart: 'unless-stopped',
        logging: { driver: 'json-file', options: { 'max-size': '10m' } },
        networks: { default: null },
        environment: { ADMIN_PASSWORD: '${ADMIN_PASSWORD}' },
        ports: [{ mode: 'ingress', target: 80, published: '${WEB_PORT}', protocol: 'tcp' }],
        volumes: [
          { type: 'bind', source: '${MEDIA_DIR}', target: '/media', read_only: true },
          { type: 'bind', source: '${DATA_DIR}', target: '/data' },
          { type: 'volume', source: 'cache', target: '/cache', volume: {} },
        ],
      },
    },
    volumes: { cache: { name: 'hl-demo_cache' } },
  };
}

let dir: string;
let storage: string;
let fake: string;
let lockFile: string;

/**
 * A free TCP port below the kernel's ephemeral range: `listen(0)` would pick from that range,
 * which the kernel also hands out for outgoing connections — another test's connection could take
 * the port before the wrapper checks it, and the test would see `port_in_use`.
 */
function freePort(): number {
  let ephemeralStart = 32_768;
  try {
    ephemeralStart = Number(
      readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').split(/\s+/)[0],
    );
  } catch {
    // Not Linux: the usual start.
  }
  const low = Math.max(1024, ephemeralStart - 12_000);
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = low + Math.floor(Math.random() * 10_000);
    const result = spawnSync(process.execPath, [
      '-e',
      `const s=require('net').createServer().once('error',()=>process.exit(1)).listen(${candidate},()=>s.close())`,
    ]);
    if (result.status === 0) return candidate;
  }
  throw new Error(`No free test port from ${low}`);
}

let port: number;

function values(change: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    WEB_PORT: port,
    MEDIA_DIR: join(storage, 'media'),
    DATA_DIR: join(storage, 'demo', 'data'),
    ADMIN_USER: 'alice',
    ADMIN_PASSWORD: 'correct horse battery',
    DB_PASSWORD: 'Zx81'.repeat(8),
    LOG_LEVEL: 'debug',
    TELEMETRY: true,
    ...change,
  };
}

function writeConfig(change: Record<string, unknown> = {}, catalogDir = join(dir, 'catalog')) {
  const config = {
    catalogDir,
    storageRoots: [storage],
    serviceRoot: storage,
    reservedPorts: [22, 3000],
    protectedPaths: [join(storage, 'platform')],
    dockerBin: fake,
    lockFile,
    home: dir,
    ...change,
  };
  writeFileSync(join(dir, 'wrappers.json'), JSON.stringify(config));
}

interface Run {
  code: number | null;
  lines: string[];
  markers: string[];
}

function run(
  args: string[],
  input = '',
  env: Record<string, string> = {},
  cwd?: string,
): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WRAPPER, ...args], {
      env: { LARIS_WRAPPER_CONFIG: join(dir, 'wrappers.json'), ...env },
      cwd,
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stdin.end(input);
    child.on('close', (code) => {
      const lines = out.split('\n').filter(Boolean);
      resolve({ code, lines, markers: lines.filter((line) => line.startsWith('@@')) });
    });
  });
}

const up = (input: unknown = values(), id = 'demo') =>
  run(['up', id], typeof input === 'string' ? input : JSON.stringify(input));

function calls(): { args: string[]; env: Record<string, string>; cwd: string }[] {
  const file = join(dir, 'calls.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const commands = () =>
  calls().map((call) => call.args.find((a) => ['config', 'pull', 'up', 'down'].includes(a)));

function expectRefused(result: Run, code: string, field?: string, exitCode = 2) {
  expect(result.code, result.lines.join('\n')).toBe(exitCode);
  expect(result.markers.at(-1)).toBe(`@@error code=${code}${field ? ` field=${field}` : ''}`);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wrapper-'));
  chmodSync(dir, 0o755);
  storage = join(dir, 'storage');
  mkdirSync(join(storage, 'media'), { recursive: true });
  fake = join(dir, 'docker');
  writeFileSync(fake, FAKE_DOCKER, { mode: 0o755 });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(demoConfig()));
  mkdirSync(join(dir, 'catalog', 'demo'), { recursive: true });
  writeFileSync(join(dir, 'catalog', 'demo', 'meta.json'), JSON.stringify(meta));
  writeFileSync(join(dir, 'catalog', 'demo', 'compose.yml'), 'services: {}\n');
  lockFile = join(dir, 'run', 'compose.lock');
  port = freePort();
  writeConfig();
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('laris-compose up', () => {
  it('checks, then pulls and starts — markers in order, Compose output prefixed', async () => {
    const result = await up();
    expect(result.code, result.lines.join('\n')).toBe(0);
    expect(result.markers).toEqual(['@@phase pulling', '@@phase starting', '@@phase done']);
    // A Compose line that looks like a marker arrives prefixed, so it can't pose as one.
    expect(result.lines).toContain('> @@phase done');
    expect(result.lines).toContain('> pull step 1');
    expect(commands()).toEqual(['config', 'pull', 'up']);
  });

  it('runs Compose in exactly one way, for the reviewed recipe', async () => {
    await up();
    const recipe = join(dir, 'catalog', 'demo', 'compose.yml');
    const base = [
      'compose',
      '--progress',
      'plain',
      '-p',
      'hl-demo',
      '-f',
      recipe,
      '--project-directory',
      join(dir, 'catalog', 'demo'),
    ];
    expect(calls().map((call) => call.args)).toEqual([
      [...base, 'config', '--format', 'json'],
      [...base, 'pull'],
      [...base, 'up', '-d', '--wait', '--wait-timeout', '300', '--remove-orphans'],
    ]);
  });

  it('gives Compose a clean environment: a fixed PATH, HOME and the checked values — nothing else', async () => {
    await up();
    const env = calls()[0].env;
    expect(env).toEqual({
      PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
      HOME: dir,
      WEB_PORT: String(port),
      MEDIA_DIR: join(storage, 'media'),
      DATA_DIR: join(storage, 'demo', 'data'),
      ADMIN_USER: 'alice',
      ADMIN_PASSWORD: 'correct horse battery',
      DB_PASSWORD: 'Zx81'.repeat(8),
      LOG_LEVEL: 'debug',
      TELEMETRY: 'true',
    });
  });

  it('creates a missing folder only inside the service’s own area', async () => {
    expect(existsSync(join(storage, 'demo', 'data'))).toBe(false);
    expect((await up()).code).toBe(0);
    expect(statSync(join(storage, 'demo', 'data')).isDirectory()).toBe(true);

    rmSync(join(storage, 'media'), { recursive: true });
    expectRefused(await up(), 'path_not_found', 'MEDIA_DIR');
    expect(existsSync(join(storage, 'media'))).toBe(false);
  });

  it('mounts the real folder, symlinks resolved', async () => {
    symlinkSync(join(storage, 'media'), join(storage, 'music-link'));
    await up(values({ MEDIA_DIR: join(storage, 'music-link') }));
    expect(calls()[0].env['MEDIA_DIR']).toBe(join(storage, 'media'));
  });
});

describe('laris-compose refuses requests', () => {
  it.each([
    [[], 'invalid_request'],
    [['up'], 'invalid_request'],
    [['remove', 'demo'], 'invalid_request'],
    [['up', 'demo', 'extra'], 'invalid_request'],
    [['up', '../demo'], 'invalid_request'],
    [['up', 'Demo'], 'invalid_request'],
    [['up', 'demo;id'], 'invalid_request'],
    [['up', 'nope'], 'unknown_entry'],
  ])('%j', async (args, code) => {
    expectRefused(await run(args, JSON.stringify(values())), code);
    expect(calls()).toEqual([]);
  });

  it('refuses to run with NODE_OPTIONS set (a tripwire behind sudo and env -i)', async () => {
    const result = await run(['up', 'demo'], JSON.stringify(values()), {
      NODE_OPTIONS: '--no-warnings',
    });
    expectRefused(result, 'invalid_request', undefined, 6);
    expect(calls()).toEqual([]);
  });

  it.each(['toString', 'constructor', '__proto__'])(
    'refuses a recipe whose text field names %s as its pattern (only real patterns count)',
    async (pattern) => {
      const broken = {
        ...meta,
        fields: meta.fields.map((f) => (f.key === 'ADMIN_USER' ? { ...f, pattern } : f)),
      };
      writeFileSync(join(dir, 'catalog', 'demo', 'meta.json'), JSON.stringify(broken));
      expectRefused(await up(), 'setup', undefined, 6);
      expect(calls()).toEqual([]);
    },
  );

  it('starts through env -i, so the environment is emptied before Node starts', () => {
    const first = readFileSync(WRAPPER, 'utf8').split('\n')[0];
    expect(first).toBe('#!/usr/bin/env -S -i /usr/bin/node');
  });
});

describe('laris-compose checks every value', () => {
  it.each<[string, unknown, string, string?]>([
    ['not JSON', '{nope', 'invalid_values'],
    ['an array', '[]', 'invalid_values'],
    ['an unknown field', () => values({ EXTRA: 'x' }), 'invalid_values'],
    [
      'a missing field',
      () => (({ WEB_PORT: _, ...rest }) => rest)(values()),
      'invalid_values',
      'WEB_PORT',
    ],
    ['a port below 1024', () => values({ WEB_PORT: 80 }), 'invalid_values', 'WEB_PORT'],
    ['a port as text', () => values({ WEB_PORT: '8080' }), 'invalid_values', 'WEB_PORT'],
    ['a reserved port', () => values({ WEB_PORT: 3000 }), 'port_reserved', 'WEB_PORT'],
    ['a relative folder', () => values({ MEDIA_DIR: 'media' }), 'invalid_values', 'MEDIA_DIR'],
    ['a folder with ..', () => values({ MEDIA_DIR: '/srv/../etc' }), 'invalid_values', 'MEDIA_DIR'],
    [
      'a folder with a colon',
      () => values({ MEDIA_DIR: '/srv/a:/etc' }),
      'invalid_values',
      'MEDIA_DIR',
    ],
    ['a system folder', () => values({ MEDIA_DIR: '/etc' }), 'path_not_allowed', 'MEDIA_DIR'],
    ['the root folder', () => values({ MEDIA_DIR: '/' }), 'path_not_allowed', 'MEDIA_DIR'],
    [
      'the Docker socket',
      () => values({ MEDIA_DIR: '/var/run/docker.sock' }),
      'path_not_allowed',
      'MEDIA_DIR',
    ],
    [
      'a folder outside the storage roots',
      () => values({ MEDIA_DIR: tmpdir() }),
      'path_not_allowed',
      'MEDIA_DIR',
    ],
    ['the same folder twice', () => values({ DATA_DIR: '<media>' }), 'invalid_values', 'DATA_DIR'],
    [
      'a text breaking its pattern',
      () => values({ ADMIN_USER: 'Alice!' }),
      'invalid_values',
      'ADMIN_USER',
    ],
    [
      'a short secret',
      () => values({ ADMIN_PASSWORD: 'short' }),
      'invalid_values',
      'ADMIN_PASSWORD',
    ],
    [
      'a secret with a line break',
      () => values({ ADMIN_PASSWORD: 'long enough\npassword' }),
      'invalid_values',
      'ADMIN_PASSWORD',
    ],
    [
      'a missing generated secret',
      () => values({ DB_PASSWORD: undefined }),
      'invalid_values',
      'DB_PASSWORD',
    ],
    ['an unknown option', () => values({ LOG_LEVEL: 'trace' }), 'invalid_values', 'LOG_LEVEL'],
    ['a boolean as text', () => values({ TELEMETRY: 'true' }), 'invalid_values', 'TELEMETRY'],
  ])('refuses %s', async (_, given, code, field) => {
    const input = typeof given === 'function' ? (given as () => unknown)() : given;
    const resolved =
      typeof input === 'object' && input !== null && (input as any).DATA_DIR === '<media>'
        ? { ...(input as object), DATA_DIR: join(storage, 'media') }
        : input;
    expectRefused(await up(resolved), code, field);
    expect(commands()).toEqual([]);
  });

  it('refuses a port something already listens on', async () => {
    const server: Server = createServer();
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    try {
      expectRefused(await up(), 'port_in_use', 'WEB_PORT');
    } finally {
      server.close();
    }
  });

  it.each(['/var', '/usr', '/run'])(
    'refuses %s even if a storage root is configured too broadly (it contains a system folder)',
    async (folder) => {
      writeConfig({ storageRoots: ['/'] });
      expectRefused(await up(values({ MEDIA_DIR: folder })), 'path_not_allowed', 'MEDIA_DIR');
      expect(calls()).toEqual([]);
    },
  );

  it('refuses the backup restore area (restored platform secrets live there)', async () => {
    // Whatever the configured storage: the production restore area is refused as such.
    writeConfig({ storageRoots: [storage, '/srv/laris'] });
    expectRefused(
      await up(values({ MEDIA_DIR: '/srv/laris/restores/0193a000-20261014-030000' })),
      'path_not_allowed',
      'MEDIA_DIR',
    );
  });

  it('refuses a folder of the platform itself', async () => {
    mkdirSync(join(storage, 'platform', 'keys'), { recursive: true });
    expectRefused(
      await up(values({ MEDIA_DIR: join(storage, 'platform', 'keys') })),
      'path_not_allowed',
      'MEDIA_DIR',
    );
  });

  it('refuses a symlink that leads out of the storage roots', async () => {
    symlinkSync('/etc', join(storage, 'escape'));
    expectRefused(
      await up(values({ MEDIA_DIR: join(storage, 'escape') })),
      'path_not_allowed',
      'MEDIA_DIR',
    );
  });

  it('refuses a folder whose parent others can write (it could be swapped for a symlink)', async () => {
    mkdirSync(join(storage, 'shared', 'music'), { recursive: true });
    chmodSync(join(storage, 'shared'), 0o777);
    expectRefused(
      await up(values({ MEDIA_DIR: join(storage, 'shared', 'music') })),
      'path_not_allowed',
      'MEDIA_DIR',
    );
  });

  it('refuses more than 64 KB of input without reading it all', async () => {
    expectRefused(await up(' '.repeat(70 * 1024)), 'invalid_values');
  });
});

describe('laris-compose checks the rendered config (the policy)', () => {
  it.each<[string, (c: Record<string, any>) => void]>([
    ['privileged', (c) => (c.services.app.privileged = true)],
    ['cap_add', (c) => (c.services.app.cap_add = ['SYS_ADMIN'])],
    ['devices', (c) => (c.services.app.devices = [{ source: '/dev/sda', target: '/dev/sda' }])],
    ['host network', (c) => (c.services.app.network_mode = 'host')],
    ['host pid', (c) => (c.services.app.pid = 'host')],
    ['volumes_from', (c) => (c.services.app.volumes_from = ['other'])],
    ['security_opt', (c) => (c.services.app.security_opt = ['apparmor:unconfined'])],
    [
      'a bind mount of /etc',
      (c) => c.services.app.volumes.push({ type: 'bind', source: '/etc', target: '/host-etc' }),
    ],
    [
      'the Docker socket',
      (c) =>
        c.services.app.volumes.push({ type: 'bind', source: '/var/run/docker.sock', target: '/s' }),
    ],
    ['a read-only folder mounted writable', (c) => delete c.services.app.volumes[0].read_only],
    ['bind options', (c) => (c.services.app.volumes[1].bind = { propagation: 'rshared' })],
    ['named volume options', (c) => (c.services.app.volumes[2].volume = { subpath: 'x' })],
    ['a volume of another project', (c) => (c.services.app.volumes[2].source = 'other')],
    ['a volume named like a built-in', (c) => (c.services.app.volumes[2].source = 'constructor')],
    [
      'a volume binding a host folder',
      (c) => (c.volumes.cache = { name: 'hl-demo_cache', driver_opts: { o: 'bind', device: '/' } }),
    ],
    ['an external volume', (c) => (c.volumes.cache = { name: 'x', external: true })],
    ['an extra network', (c) => (c.networks.outside = { external: true })],
    [
      'an extra published port',
      (c) =>
        c.services.app.ports.push({
          mode: 'ingress',
          target: 22,
          published: '2222',
          protocol: 'tcp',
        }),
    ],
    ['a port on one address', (c) => (c.services.app.ports[0].host_ip = '0.0.0.0')],
    ['a port on a network address', (c) => (c.services.app.ports[0].host_ip = '192.168.1.10')],
    ['loopback written another way', (c) => (c.services.app.ports[0].host_ip = '127.0.0.2')],
    ['an empty port address', (c) => (c.services.app.ports[0].host_ip = '')],
    ['an image without a digest', (c) => (c.services.app.image = 'example/app:latest')],
    ['another restart policy', (c) => (c.services.app.restart = 'always')],
    ['no log rotation', (c) => delete c.services.app.logging],
    ['a protected label', (c) => (c.services.app.labels = { 'laris.protected': 'true' })],
    [
      'a Compose project label',
      (c) => (c.services.app.labels = { 'com.docker.compose.project': 'hl-other' }),
    ],
    ['another project name', (c) => (c.name = 'other')],
    ['a top-level secret', (c) => (c.secrets = { s: { file: '/etc/shadow' } })],
  ])('refuses %s, before pulling or starting anything', async (_, change) => {
    const config = demoConfig();
    change(config);
    writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
    expectRefused(await up(), 'policy_violation', undefined, 4);
    expect(commands()).toEqual(['config']);
  });

  it('accepts a port bound to loopback only (a service without its own sign-in)', async () => {
    const config = demoConfig();
    config.services.app.ports[0].host_ip = '127.0.0.1';
    writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
    const result = await up();
    expect(result.code, result.lines.join('\n')).toBe(0);
    expect(commands()).toEqual(['config', 'pull', 'up']);
  });

  it.skipIf(!REAL_DOCKER)(
    'passes the real catalog recipes, rendered by the real Compose',
    async () => {
      writeFileSync(join(dir, 'real-docker.txt'), REAL_DOCKER!);
      writeConfig({}, CATALOG);
      const navidrome = await up(
        {
          WEB_PORT: port,
          MUSIC_DIR: join(storage, 'navidrome', 'music'),
          DATA_DIR: join(storage, 'navidrome', 'data'),
        },
        'navidrome',
      );
      expect(navidrome.code, navidrome.lines.join('\n')).toBe(0);
      const immich = await up(
        {
          WEB_PORT: port,
          UPLOAD_DIR: join(storage, 'immich', 'library'),
          TZ: 'Europe/Berlin',
          DB_PASSWORD: 'Zx81'.repeat(8),
        },
        'immich',
      );
      expect(immich.code, immich.lines.join('\n')).toBe(0);
    },
  );
});

describe('laris-compose failures, down and the lock', () => {
  it('reports a failed Compose step', async () => {
    writeFileSync(join(dir, 'exit-up.txt'), '1');
    const result = await up();
    expectRefused(result, 'compose_failed', undefined, 5);
    expect(result.markers).toContain('@@phase starting');
    expect(result.markers).not.toContain('@@phase done');
  });

  it('removes by project name only, keeping volumes (no -v)', async () => {
    const result = await run(['down', 'demo']);
    expect(result.code, result.lines.join('\n')).toBe(0);
    expect(result.markers).toEqual(['@@phase removing', '@@phase done']);
    expect(calls().map((call) => call.args)).toEqual([
      ['compose', '--progress', 'plain', '-p', 'hl-demo', 'down', '--remove-orphans'],
    ]);
    expect(calls()[0].env).toEqual({ PATH: '/usr/sbin:/usr/bin:/sbin:/bin', HOME: dir });
  });

  it('runs Compose in /, never in the caller’s folder (where a compose.yml could be planted)', async () => {
    const planted = join(dir, 'planted');
    mkdirSync(planted);
    writeFileSync(
      join(planted, 'compose.yml'),
      'services: { x: { image: evil, privileged: true } }\n',
    );
    expect((await run(['down', 'demo'], '', {}, planted)).code).toBe(0);
    expect((await run(['up', 'demo'], JSON.stringify(values()), {}, planted)).code).toBe(0);
    expect(calls().map((call) => call.cwd)).toEqual(['/', '/', '/', '/']);
  });

  it('refuses values for down', async () => {
    expectRefused(await run(['down', 'demo'], '{}'), 'invalid_request');
    expect(calls()).toEqual([]);
  });

  it('runs one operation at a time', async () => {
    writeFileSync(join(dir, 'sleep-pull.txt'), '1500');
    const first = up();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expectRefused(await run(['down', 'demo']), 'busy', undefined, 3);
    expect((await first).code).toBe(0);
    expect(existsSync(lockFile)).toBe(false);
  });

  it('takes over the lock of an operation that died', async () => {
    mkdirSync(join(dir, 'run'), { recursive: true });
    writeFileSync(lockFile, '999999999');
    expect((await up()).code).toBe(0);
  });

  it('never takes over a lock being written, only one long dead', async () => {
    mkdirSync(join(dir, 'run'), { recursive: true });
    writeFileSync(lockFile, ''); // an older writer between creating and writing it
    expectRefused(await up(), 'busy', undefined, 3);
    const old = new Date(Date.now() - 120_000);
    utimesSync(lockFile, old, old);
    expect((await up()).code).toBe(0);
  });

  it('stops Compose and releases the lock on SIGTERM', async () => {
    writeFileSync(join(dir, 'sleep-pull.txt'), '5000');
    const child = spawn(process.execPath, [WRAPPER, 'up', 'demo'], {
      env: { LARIS_WRAPPER_CONFIG: join(dir, 'wrappers.json') },
    });
    child.stdin.end(JSON.stringify(values()));
    await new Promise((resolve) => setTimeout(resolve, 700));
    child.kill('SIGTERM');
    const code = await new Promise((resolve) => child.on('close', (c) => resolve(c)));
    expect(code).toBe(143);
    expect(existsSync(lockFile)).toBe(false);
  });
});

describe('the sudoers drop-in', () => {
  it.skipIf(!existsSync('/usr/bin/visudo') && !existsSync('/usr/sbin/visudo'))(
    'passes visudo',
    () => {
      const visudo = existsSync('/usr/sbin/visudo') ? '/usr/sbin/visudo' : '/usr/bin/visudo';
      const result = spawnSync(visudo, ['-cf', SUDOERS]);
      expect(result.status, result.stdout.toString() + result.stderr.toString()).toBe(0);
    },
  );

  it('allows exactly the wrappers, by absolute path — no wildcards, no other commands', () => {
    const rules = readFileSync(SUDOERS, 'utf8')
      .split('\n')
      .filter((line) => line.trim() && !line.startsWith('#') && !line.startsWith('Defaults'));
    expect(rules).toEqual([
      'laris ALL=(root) NOPASSWD: /opt/laris/libexec/laris-compose.mts',
      'laris ALL=(root) NOPASSWD: /opt/laris/libexec/laris-backup.mts',
      'laris ALL=(root) NOPASSWD: /opt/laris/libexec/laris-disk.mts',
    ]);
    expect(readFileSync(SUDOERS, 'utf8')).toContain('Defaults:laris env_reset, !env_keep');
  });
});
