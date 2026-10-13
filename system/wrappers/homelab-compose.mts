#!/usr/bin/env -S -i /usr/bin/node
// homelab-compose — REVIEW-REQUIRED (system/CLAUDE.md). Runs as root through sudo.
//
//   homelab-compose up   <catalog id>    values as JSON on stdin
//   homelab-compose down <catalog id>    nothing on stdin
//
// The app (user "homelab") may run this one program as root, nothing else. It treats the app as
// a possible attacker: it deploys only reviewed recipes from the root-owned catalog, fills their
// ${KEY} blanks only with values that pass its own checks (written independently of the app's),
// checks Compose's final rendered config against the policy, and runs Compose in one fixed way.
// Design: docs/plans/service_deploys.md (decisions 1, 2, 5, 6).
//
// Zero dependencies on purpose: only node: built-ins — any package it loaded would run as root.
// `env -i` in the shebang empties the environment before Node starts (NODE_OPTIONS could
// otherwise load code); sudo's env_reset does the same.
//
// Output (stdout): its own markers — `@@phase <phase>`, `@@error code=<code>[ field=<KEY>]`,
// `@@info <text>` — and Compose's output, every line prefixed with "> ", so only this program
// can write a line starting with "@@".
//
// Exit codes: 0 done · 2 refused input · 3 busy · 4 policy violation · 5 Compose failed ·
// 6 setup problem (config, catalog) · 143 stopped by SIGTERM.

import { spawn, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  chownSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------------------------
// Fixed facts

/** Root mode reads its config from here, and only if root owns it and its folders. */
const ROOT_CONFIG = '/etc/homelab/wrappers.json';
const ROOT_LOCK = '/run/homelab/compose.lock';
const SAFE_PATH = '/usr/sbin:/usr/bin:/sbin:/bin';
const MAX_INPUT_BYTES = 64 * 1024;
const WAIT_TIMEOUT_SECONDS = 300;

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,39}$/;
const PORT_MIN = 1024;
const PORT_MAX = 65535;
const SECRET_PATTERN = /^[^\x00-\x1f\x7f]{12,128}$/;
const TEXT_PATTERNS: Record<string, RegExp> = {
  username: /^[a-z0-9_.-]{1,64}$/,
  timezone: /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/,
};
const ENUM_OPTION_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const PATH_FORBIDDEN = /[\x00-\x1f\x7f:,]/;
const PATH_MAX = 1024;
/** Never mounted, whatever the config says. */
const DENIED_PATHS = [
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/lib',
  '/lib32',
  '/lib64',
  '/proc',
  '/root',
  '/run',
  '/sbin',
  '/sys',
  '/usr',
  '/var/lib/docker',
  '/var/run',
];
const PINNED_IMAGE = /^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$/;
const RESERVED_LABEL = /^(homelab\.|com\.docker\.compose\.)/;
const SERVICE_KEYS = new Set([
  'image',
  'command',
  'entrypoint',
  'environment',
  'user',
  'working_dir',
  'ports',
  'expose',
  'volumes',
  'tmpfs',
  'depends_on',
  'restart',
  'healthcheck',
  'logging',
  'labels',
  'shm_size',
  'init',
  'read_only',
  'stop_grace_period',
  'stop_signal',
  'mem_limit',
  'cpus',
  'pids_limit',
  'ulimits',
  'networks',
]);

// ---------------------------------------------------------------------------------------------
// Types (erasable syntax only: Node strips them before running)

interface Config {
  /** Where the reviewed recipes are: <catalogDir>/<id>/{meta.json,compose.yml}. */
  catalogDir: string;
  /** Folder fields must resolve inside one of these. */
  storageRoots: string[];
  /** Missing folders are created only inside <serviceRoot>/<id>/. */
  serviceRoot: string;
  /** Ports never given to a service (SSH, the app, Postgres, the proxy, Tailscale…). */
  reservedPorts: number[];
  /** Folders of the platform itself: never mounted. */
  protectedPaths: string[];
  dockerBin: string;
  /** Development only: the lock file and HOME for docker (root mode uses fixed ones). */
  lockFile?: string;
  home?: string;
}

interface Field {
  key: string;
  type: 'port' | 'path' | 'text' | 'secret' | 'generatedSecret' | 'enum' | 'boolean';
  access?: 'read' | 'write';
  pattern?: string;
  options?: string[];
}

interface Meta {
  id: string;
  dataOwner: { uid: number; gid: number };
  fields: Field[];
}

/** A refusal with its code (and the field it's about), reported as `@@error`. */
class Refusal extends Error {
  readonly code: string;
  readonly field: string | undefined;
  readonly exitCode: number;
  constructor(code: string, message: string, field?: string, exitCode = 2) {
    super(message);
    this.code = code;
    this.field = field;
    this.exitCode = exitCode;
  }
}

// ---------------------------------------------------------------------------------------------
// Output

function emit(line: string): void {
  writeSync(1, `${line}\n`);
}

/** Compose's output, line by line, each prefixed with "> " (never mistaken for a marker). */
function relay(stream: NodeJS.ReadableStream): void {
  let rest = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    const lines = (rest + chunk).split(/\r?\n/);
    rest = lines.pop() ?? '';
    for (const line of lines) emit(`> ${line}`);
  });
  stream.on('end', () => {
    if (rest) emit(`> ${rest}`);
  });
}

// ---------------------------------------------------------------------------------------------
// Start-up checks

const isRoot = process.getuid?.() === 0;

function checkStartup(): { action: 'up' | 'down'; id: string } {
  // A tripwire, not the lock: Node has already applied NODE_OPTIONS by now (see the header).
  if (process.env['NODE_OPTIONS'] !== undefined || process.execArgv.length > 0) {
    throw new Refusal('invalid_request', 'Node was started with options', undefined, 6);
  }
  const args = process.argv.slice(2);
  const [action, id] = args;
  if (args.length !== 2 || (action !== 'up' && action !== 'down')) {
    throw new Refusal('invalid_request', 'usage: homelab-compose up|down <catalog id>');
  }
  if (!ID_PATTERN.test(id)) throw new Refusal('invalid_request', 'not a catalog id');
  return { action, id };
}

/**
 * Root mode: the config, and every folder above it, must belong to root and be writable by no
 * one else — otherwise the app could have written it. Development mode (not root): the file
 * named by HOMELAB_WRAPPER_CONFIG, for tests and a machine without sudoers.
 */
function loadConfig(): Config {
  const path = isRoot ? ROOT_CONFIG : process.env['HOMELAB_WRAPPER_CONFIG'];
  if (!path) throw new Refusal('setup', 'no configuration', undefined, 6);
  if (isRoot) assertRootOwned(path);
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const config = raw as Config;
  const absolute = (p: unknown) => typeof p === 'string' && isPlainAbsolutePath(p);
  if (
    !absolute(config.catalogDir) ||
    !absolute(config.serviceRoot) ||
    !absolute(config.dockerBin) ||
    !Array.isArray(config.storageRoots) ||
    !config.storageRoots.every(absolute) ||
    !Array.isArray(config.protectedPaths) ||
    !config.protectedPaths.every(absolute) ||
    !Array.isArray(config.reservedPorts) ||
    !config.reservedPorts.every((p) => Number.isInteger(p))
  ) {
    throw new Refusal('setup', `invalid configuration ${path}`, undefined, 6);
  }
  return config;
}

/** The path and every folder above it: owned by root, not writable by group or others. */
function assertRootOwned(path: string): void {
  for (let current = path; ; current = dirname(current)) {
    const stat = lstatSync(current);
    if (stat.uid !== 0 || (stat.mode & 0o022) !== 0 || stat.isSymbolicLink()) {
      throw new Refusal(
        'setup',
        `${current} must belong to root and be writable only by root`,
        undefined,
        6,
      );
    }
    if (current === '/') return;
  }
}

// ---------------------------------------------------------------------------------------------
// The catalog entry (root-owned, reviewed — still only the parts this program relies on)

function loadEntry(config: Config, id: string): { meta: Meta; composeFile: string; dir: string } {
  const dir = join(config.catalogDir, id);
  const metaFile = join(dir, 'meta.json');
  const composeFile = join(dir, 'compose.yml');
  if (!existsSync(metaFile) || !existsSync(composeFile)) {
    throw new Refusal('unknown_entry', `no catalog entry ${id}`);
  }
  if (isRoot) for (const file of [metaFile, composeFile]) assertRootOwned(file);
  const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as Meta;
  const types = new Set(['port', 'path', 'text', 'secret', 'generatedSecret', 'enum', 'boolean']);
  const owner = meta.dataOwner;
  const valid =
    meta.id === id &&
    Array.isArray(meta.fields) &&
    Number.isInteger(owner?.uid) &&
    Number.isInteger(owner?.gid) &&
    meta.fields.every(
      (f) =>
        KEY_PATTERN.test(f.key) &&
        types.has(f.type) &&
        (f.type !== 'path' || f.access === 'read' || f.access === 'write') &&
        // Own keys only: `in` would also accept names every object has (`toString`, `constructor`).
        (f.type !== 'text' ||
          (f.pattern !== undefined && Object.hasOwn(TEXT_PATTERNS, f.pattern))) &&
        (f.type !== 'enum' ||
          (Array.isArray(f.options) && f.options.every((o) => ENUM_OPTION_PATTERN.test(o)))),
    ) &&
    new Set(meta.fields.map((f) => f.key)).size === meta.fields.length;
  if (!valid) throw new Refusal('setup', `catalog entry ${id} is invalid`, undefined, 6);
  return { meta, composeFile, dir };
}

// ---------------------------------------------------------------------------------------------
// Values

/** Reads stdin, refusing more than MAX_INPUT_BYTES (a bigger input is never read into memory). */
function readInput(): string {
  const buffer = Buffer.alloc(MAX_INPUT_BYTES + 1);
  let length = 0;
  for (;;) {
    let read: number;
    try {
      read = readSync(0, buffer, length, buffer.length - length, null);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EAGAIN') continue;
      if ((error as NodeJS.ErrnoException).code === 'EOF') break;
      throw error;
    }
    if (read === 0) break;
    length += read;
    if (length > MAX_INPUT_BYTES) throw new Refusal('invalid_values', 'input too large');
  }
  return buffer.subarray(0, length).toString('utf8');
}

interface CheckedValues {
  /** Field key → the text Compose substitutes. */
  env: Record<string, string>;
  /** Resolved folder → its access, for the policy check. */
  folders: Map<string, 'read' | 'write'>;
  /** Published ports, as Compose renders them (text). */
  ports: Set<string>;
}

function checkValues(input: string, meta: Meta, config: Config): CheckedValues {
  let values: unknown;
  try {
    values = JSON.parse(input);
  } catch {
    throw new Refusal('invalid_values', 'not JSON');
  }
  if (typeof values !== 'object' || values === null || Array.isArray(values)) {
    throw new Refusal('invalid_values', 'not an object');
  }
  const given = values as Record<string, unknown>;
  const declared = new Set(meta.fields.map((f) => f.key));
  for (const key of Object.keys(given)) {
    if (!declared.has(key)) throw new Refusal('invalid_values', `unknown field ${key}`);
  }

  const checked: CheckedValues = { env: {}, folders: new Map(), ports: new Set() };
  const listening = listeningPorts();
  for (const field of meta.fields) {
    const value = given[field.key];
    const refuse = (code = 'invalid_values', why = 'invalid value') => {
      throw new Refusal(code, `${field.key}: ${why}`, field.key);
    };
    if (value === undefined) refuse('invalid_values', 'missing');
    switch (field.type) {
      case 'port': {
        if (
          typeof value !== 'number' ||
          !Number.isInteger(value) ||
          value < PORT_MIN ||
          value > PORT_MAX
        )
          refuse();
        const port = value as number;
        if (config.reservedPorts.includes(port)) refuse('port_reserved', 'reserved port');
        if (listening.has(port) || checked.ports.has(String(port)))
          refuse('port_in_use', 'port in use');
        checked.ports.add(String(port));
        checked.env[field.key] = String(port);
        break;
      }
      case 'path': {
        if (typeof value !== 'string' || !isPlainAbsolutePath(value)) refuse();
        const folder = resolveFolder(value as string, meta, config, field.key);
        if (checked.folders.has(folder)) refuse('invalid_values', 'the same folder twice');
        checked.folders.set(folder, field.access as 'read' | 'write');
        checked.env[field.key] = folder;
        break;
      }
      case 'text': {
        const name = field.pattern as string;
        const pattern = Object.hasOwn(TEXT_PATTERNS, name) ? TEXT_PATTERNS[name] : undefined;
        if (!pattern) refuse();
        if (typeof value !== 'string' || value.length > 128 || !pattern.test(value)) refuse();
        checked.env[field.key] = value as string;
        break;
      }
      case 'secret':
      case 'generatedSecret': {
        if (typeof value !== 'string' || !SECRET_PATTERN.test(value)) refuse();
        checked.env[field.key] = value as string;
        break;
      }
      case 'enum': {
        if (typeof value !== 'string' || !(field.options as string[]).includes(value)) refuse();
        checked.env[field.key] = value as string;
        break;
      }
      case 'boolean': {
        if (typeof value !== 'boolean') refuse();
        checked.env[field.key] = String(value);
        break;
      }
    }
  }
  return checked;
}

function isPlainAbsolutePath(path: string): boolean {
  if (!path.startsWith('/') || path.length > PATH_MAX || PATH_FORBIDDEN.test(path)) return false;
  if (path === '/') return true;
  return path
    .slice(1)
    .split('/')
    .every((s) => s !== '' && s !== '.' && s !== '..');
}

const inside = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

/**
 * A folder field's value → the real folder Compose mounts. It must be inside a storage root and
 * stay there once symlinks are resolved; never a system or platform folder; and no folder above
 * it may be writable by anyone but root (in development: root or this user) — otherwise one
 * could be swapped for a symlink between this check and Docker's mount. Missing folders are
 * created only inside the service's own area, owned by its dataOwner.
 */
function resolveFolder(value: string, meta: Meta, config: Config, key: string): string {
  const refuse = (code: string, why: string): never => {
    throw new Refusal(code, `${key}: ${why}`, key);
  };
  const allowed = (path: string) =>
    config.storageRoots.some((root) => inside(path, root)) &&
    path !== '/' &&
    // Neither inside a system folder nor containing one (`/var` holds the Docker socket).
    !DENIED_PATHS.some((denied) => inside(path, denied) || inside(denied, path)) &&
    !config.protectedPaths.some((denied) => inside(path, denied) || inside(denied, path));
  if (!allowed(value)) refuse('path_not_allowed', 'not inside an allowed folder');

  if (!existsSync(value)) {
    const own = join(config.serviceRoot, meta.id);
    if (!inside(value, own) || value === own) refuse('path_not_found', 'does not exist');
    createServiceFolder(value, own, meta);
  }
  const real = realpathSync(value);
  if (!allowed(real)) refuse('path_not_allowed', 'resolves outside an allowed folder');
  if (!statSync(real).isDirectory()) refuse('path_not_found', 'not a folder');

  const me = process.getuid?.() ?? 0;
  for (let parent = dirname(real); ; parent = dirname(parent)) {
    // Development mode only checks from the storage root down (test folders live in /tmp).
    if (!isRoot && !config.storageRoots.some((root) => inside(parent, root))) break;
    const stat = lstatSync(parent);
    const owner = stat.uid === 0 || (!isRoot && stat.uid === me);
    if (!owner || (stat.mode & 0o022) !== 0) {
      refuse('path_not_allowed', `${parent} is writable by others than root`);
    }
    if (parent === '/') break;
  }
  return real;
}

/** Creates <own>/… : folders up to the leaf as root 0755, the leaf owned by the dataOwner. */
function createServiceFolder(path: string, own: string, meta: Meta): void {
  const parts = path.slice(own.length).split('/').filter(Boolean);
  let current = own;
  for (const [i, part] of [undefined, ...parts].entries()) {
    if (part !== undefined) current = join(current, part);
    if (existsSync(current)) {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Refusal('path_not_allowed', `${current} is a symlink`);
      }
      continue;
    }
    mkdirSync(current, { mode: 0o755 });
    const leaf = i === parts.length;
    if (isRoot && leaf) chownSync(current, meta.dataOwner.uid, meta.dataOwner.gid);
    // Development mode can't hand the folder to the service's user: let any user write it.
    if (!isRoot && leaf) chmodSync(current, 0o777);
  }
}

/** TCP ports something listens on (IPv4 and IPv6), from /proc/net. */
function listeningPorts(): Set<number> {
  const ports = new Set<number>();
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n').slice(1)) {
      const columns = line.trim().split(/\s+/);
      // local_address is "ADDR:PORT" in hex; state 0A = LISTEN.
      if (columns[3] === '0A') ports.add(parseInt(columns[1].split(':')[1], 16));
    }
  }
  return ports;
}

// ---------------------------------------------------------------------------------------------
// The policy, on Compose's own rendered config (one normalised form for everything)

function checkPolicy(config: unknown, project: string, values: CheckedValues): void {
  const fail = (where: string, what: string): never => {
    throw new Refusal('policy_violation', `${where}: ${what}`, undefined, 4);
  };
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isObject(config)) return fail('config', 'not an object');

  for (const key of Object.keys(config)) {
    if (!['name', 'services', 'volumes', 'networks'].includes(key)) fail(key, 'not allowed');
  }
  if (config['name'] !== project) fail('name', 'unexpected project name');

  const networks = config['networks'] ?? {};
  if (!isObject(networks)) return fail('networks', 'not a mapping');
  for (const [name, network] of Object.entries(networks)) {
    if (name !== 'default' || !isObject(network))
      fail(`networks.${name}`, 'only the default network');
    for (const [key, value] of Object.entries(network as Record<string, unknown>)) {
      const plain =
        (key === 'name' && value === `${project}_default`) ||
        (key === 'ipam' && isObject(value) && Object.keys(value).length === 0);
      if (!plain) fail(`networks.${name}.${key}`, 'not allowed');
    }
  }

  const volumes = config['volumes'] ?? {};
  if (!isObject(volumes)) return fail('volumes', 'not a mapping');
  for (const [name, volume] of Object.entries(volumes)) {
    const keys = isObject(volume) ? Object.keys(volume) : ['?'];
    if (
      keys.some((k) => k !== 'name') ||
      (volume as { name?: unknown }).name !== `${project}_${name}`
    ) {
      fail(`volumes.${name}`, 'named volumes take no options');
    }
  }

  const services = config['services'];
  if (!isObject(services) || Object.keys(services).length === 0) return fail('services', 'none');
  for (const [name, service] of Object.entries(services)) {
    const at = `services.${name}`;
    if (!isObject(service)) return fail(at, 'not a mapping');
    for (const key of Object.keys(service))
      if (!SERVICE_KEYS.has(key)) fail(`${at}.${key}`, 'not allowed');

    if (typeof service['image'] !== 'string' || !PINNED_IMAGE.test(service['image'])) {
      fail(`${at}.image`, 'not pinned by digest');
    }
    if (service['restart'] !== 'unless-stopped') fail(`${at}.restart`, 'must be unless-stopped');
    const logging = service['logging'];
    const options = isObject(logging) ? logging['options'] : undefined;
    if (
      !isObject(logging) ||
      !['json-file', 'local'].includes(String(logging['driver'])) ||
      !isObject(options) ||
      !options['max-size']
    ) {
      fail(`${at}.logging`, 'no log rotation');
    }
    const serviceNetworks = service['networks'];
    if (
      serviceNetworks !== undefined &&
      !(isObject(serviceNetworks) && Object.keys(serviceNetworks).every((n) => n === 'default'))
    ) {
      fail(`${at}.networks`, 'only the default network');
    }

    for (const port of asArray(service['ports'], `${at}.ports`, fail)) {
      if (!isObject(port)) return fail(`${at}.ports`, 'not a mapping');
      const keysOk = Object.keys(port).every((k) =>
        ['mode', 'target', 'published', 'protocol'].includes(k),
      );
      if (
        !keysOk ||
        port['mode'] !== 'ingress' ||
        !values.ports.has(String(port['published'])) ||
        !['tcp', 'udp'].includes(String(port['protocol']))
      ) {
        fail(`${at}.ports`, `port ${String(port['published'])} is not a validated port field`);
      }
    }

    for (const volume of asArray(service['volumes'], `${at}.volumes`, fail)) {
      if (!isObject(volume)) return fail(`${at}.volumes`, 'not a mapping');
      for (const key of Object.keys(volume)) {
        // Compose writes an empty `volume: {}` for named volumes; options there are refused.
        const emptyVolumeOptions =
          key === 'volume' &&
          volume['type'] === 'volume' &&
          isObject(volume['volume']) &&
          Object.keys(volume['volume']).length === 0;
        if (!['type', 'source', 'target', 'read_only'].includes(key) && !emptyVolumeOptions) {
          fail(`${at}.volumes.${key}`, 'not allowed');
        }
      }
      const source = String(volume['source']);
      if (volume['type'] === 'volume') {
        if (!Object.hasOwn(volumes, source))
          fail(`${at}.volumes`, `${source} is not a volume of this project`);
      } else if (volume['type'] === 'bind') {
        const access = values.folders.get(source);
        if (!access) fail(`${at}.volumes`, `${source} is not a validated folder field`);
        if (access === 'read' && volume['read_only'] !== true)
          fail(`${at}.volumes`, `${source} must be read-only`);
      } else {
        fail(`${at}.volumes`, `type ${String(volume['type'])} not allowed`);
      }
    }

    const labels = service['labels'];
    const labelKeys = isObject(labels) ? Object.keys(labels) : [];
    if (labels !== undefined && !isObject(labels)) fail(`${at}.labels`, 'not a mapping');
    for (const label of labelKeys)
      if (RESERVED_LABEL.test(label)) fail(`${at}.labels`, `reserved label ${label}`);
  }
}

function asArray(value: unknown, where: string, fail: (w: string, m: string) => never): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return fail(where, 'not a list');
  return value;
}

// ---------------------------------------------------------------------------------------------
// Running Compose — one fixed way, a clean environment

let current: ChildProcess | null = null;

function compose(
  config: Config,
  project: string,
  composeFile: string | null,
  args: string[],
  env: Record<string, string>,
  capture = false,
): Promise<{ code: number; stdout: string }> {
  const fileArgs = composeFile
    ? ['-f', composeFile, '--project-directory', dirname(composeFile)]
    : [];
  const fullArgs = ['compose', '--progress', 'plain', '-p', project, ...fileArgs, ...args];
  const home = isRoot ? '/root' : (config.home ?? '/tmp');
  return new Promise((resolve, reject) => {
    const child = spawn(config.dockerBin, fullArgs, {
      // Built from scratch: nothing from this program's own environment reaches Compose.
      env: { PATH: SAFE_PATH, HOME: home, ...env },
      // Never the caller's folder: without -f (down), Compose would load a compose.yml found
      // there — one the app could have planted. `/` is root's, and has no compose file.
      cwd: '/',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    current = child;
    let stdout = '';
    if (capture) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
        if (stdout.length > 4 * 1024 * 1024) child.kill('SIGTERM');
      });
    } else {
      relay(child.stdout);
    }
    relay(child.stderr);
    child.on('error', reject);
    child.on('close', (code) => {
      current = null;
      resolve({ code: code ?? 1, stdout });
    });
  });
}

// ---------------------------------------------------------------------------------------------
// One operation at a time

function takeLock(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          unlinkSync(path);
        } catch {
          // already gone
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(readFileSync(path, 'utf8'));
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) {
        throw new Refusal('busy', 'another install or removal is running', undefined, 3);
      }
      unlinkSync(path); // its owner died: take it over
    }
  }
  throw new Refusal('busy', 'could not take the lock', undefined, 3);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// ---------------------------------------------------------------------------------------------
// Main

async function main(): Promise<number> {
  process.umask(0o077);
  const { action, id } = checkStartup();
  const config = loadConfig();
  const project = `hl-${id}`;
  const input = readInput();

  const release = takeLock(
    isRoot ? ROOT_LOCK : (config.lockFile ?? join(config.catalogDir, '.lock')),
  );
  const stop = () => {
    current?.kill('SIGTERM');
    release();
    process.exit(143);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    if (action === 'down') {
      if (input.length > 0) throw new Refusal('invalid_request', 'down takes no input');
      if (!existsSync(join(config.catalogDir, id)))
        throw new Refusal('unknown_entry', `no catalog entry ${id}`);
      emit('@@phase removing');
      // By project name only: removes its containers and network, never its volumes (no -v).
      const down = await compose(config, project, null, ['down', '--remove-orphans'], {});
      if (down.code !== 0)
        throw new Refusal('compose_failed', 'docker compose down failed', undefined, 5);
      emit('@@phase done');
      return 0;
    }

    const { meta, composeFile } = loadEntry(config, id);
    // Folders are created (if missing) with their final owner, so allow group/other reads again.
    process.umask(0o022);
    const values = checkValues(input, meta, config);
    process.umask(0o077);

    const rendered = await compose(
      config,
      project,
      composeFile,
      ['config', '--format', 'json'],
      values.env,
      true,
    );
    if (rendered.code !== 0)
      throw new Refusal('compose_failed', 'docker compose config failed', undefined, 5);
    let parsed: unknown;
    try {
      parsed = JSON.parse(rendered.stdout);
    } catch {
      throw new Refusal('compose_failed', 'docker compose config printed no JSON', undefined, 5);
    }
    checkPolicy(parsed, project, values);

    emit('@@phase pulling');
    const pull = await compose(config, project, composeFile, ['pull'], values.env);
    if (pull.code !== 0)
      throw new Refusal('compose_failed', 'docker compose pull failed', undefined, 5);

    emit('@@phase starting');
    const up = await compose(
      config,
      project,
      composeFile,
      ['up', '-d', '--wait', '--wait-timeout', String(WAIT_TIMEOUT_SECONDS), '--remove-orphans'],
      values.env,
    );
    if (up.code !== 0)
      throw new Refusal('compose_failed', 'docker compose up failed', undefined, 5);
    emit('@@phase done');
    return 0;
  } finally {
    release();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof Refusal) {
      emit(`@@info ${error.message.replace(/[\r\n]/g, ' ')}`);
      emit(`@@error code=${error.code}${error.field ? ` field=${error.field}` : ''}`);
      process.exit(error.exitCode);
    }
    emit(
      `@@info unexpected error: ${String((error as Error)?.message ?? error).replace(/[\r\n]/g, ' ')}`,
    );
    emit('@@error code=internal');
    process.exit(6);
  },
);
