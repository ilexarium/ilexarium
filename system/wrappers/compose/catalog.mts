// compose/catalog.mts — REVIEW-REQUIRED (system/CLAUDE.md): runs as root.
//
// The catalog entry (root-owned, reviewed — still only the parts this program relies on).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.mts';
import { Refusal } from '../lib/output.mts';
import { assertRootOwned } from '../lib/paths.mts';
import { isRoot } from '../lib/startup.mts';

export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,39}$/;

export const TEXT_PATTERNS: Record<string, RegExp> = {
  username: /^[a-z0-9_.-]{1,64}$/,
  timezone: /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/,
};

export const ENUM_OPTION_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

export interface Field {
  key: string;
  type: 'port' | 'path' | 'text' | 'secret' | 'generatedSecret' | 'enum' | 'boolean';
  access?: 'read' | 'write';
  pattern?: string;
  options?: string[];
}

export interface Meta {
  id: string;
  dataOwner: { uid: number; gid: number };
  fields: Field[];
}

export function loadEntry(
  config: Config,
  id: string,
): { meta: Meta; composeFile: string; dir: string } {
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
  if (!valid) throw new Refusal('setup', `catalog entry ${id} is invalid`, 6);
  return { meta, composeFile, dir };
}
