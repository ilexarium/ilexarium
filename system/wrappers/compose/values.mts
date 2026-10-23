// compose/values.mts — REVIEW-REQUIRED (system/CLAUDE.md): runs as root.
//
// The values the app sends, each checked by its field's type; folders resolved and checked.

import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { TEXT_PATTERNS } from './catalog.mts';
import type { Meta } from './catalog.mts';
import type { Config } from './config.mts';
import { Refusal } from '../lib/output.mts';
import { DENIED_PATHS, inside, isPlainAbsolutePath } from '../lib/paths.mts';
import { isRoot } from '../lib/startup.mts';

export const PORT_MIN = 1024;

export const PORT_MAX = 65535;

export const SECRET_PATTERN = /^[^\x00-\x1f\x7f]{12,128}$/;
export const TEXT_MAX = 128;

export interface CheckedValues {
  /** Field key → the text Compose substitutes. */
  env: Record<string, string>;
  /** Resolved folder → its access, for the policy check. */
  folders: Map<string, 'read' | 'write'>;
  /** Published ports, as Compose renders them (text). */
  ports: Set<string>;
}

export function checkValues(input: string, meta: Meta, config: Config): CheckedValues {
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
    const refuse = (code = 'invalid_values', why = 'invalid value'): never => {
      throw new Refusal(code, `${field.key}: ${why}`, 2, field.key);
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
        if (!pattern) return refuse();
        if (typeof value !== 'string' || value.length > TEXT_MAX || !pattern.test(value)) refuse();
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

export function resolveFolder(value: string, meta: Meta, config: Config, key: string): string {
  const refuse = (code: string, why: string): never => {
    throw new Refusal(code, `${key}: ${why}`, 2, key);
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
export function createServiceFolder(path: string, own: string, meta: Meta): void {
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
export function listeningPorts(): Set<number> {
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
