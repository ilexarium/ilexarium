// backup/plan.mts — REVIEW-REQUIRED (system/CLAUDE.md): runs as root.
//
// The plan (from the app through `configure`; re-checked whenever it's read) and the recipes'
// backup sections.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { absolute, isObject } from './config.mts';
import type { Config, Paths, Plan, Recipe } from './model.mts';
import { allowedFolder, allowedServiceFolder, below, overlaps } from './places.mts';
import { Refusal } from '../lib/output.mts';
import { assertRootOwned } from '../lib/paths.mts';
import { isRoot } from '../lib/startup.mts';

export const MAX_ITEMS = 100;

export const MAX_SKIPS = 20;

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,39}$/;

export const TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export const ARCHIVE_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

/** A plain name inside a folder: no "/", not "." or "..", no wildcards, no leading "-". */
export const SKIP_PATTERN = /^(?!-)(?!\.{1,2}$)[^/\x00-\x1f\x7f*?[\]\\]{1,255}$/;

export function checkPlan(raw: unknown, config: Config, paths: Paths): Plan {
  const refuse = (why: string): never => {
    throw new Refusal('invalid_plan', why);
  };
  if (!isObject(raw)) return refuse('not an object');
  exactKeys(raw, ['destination', 'schedule', 'retention', 'items'], [], 'plan');
  const { destination, schedule, retention, items } = raw;
  if (!absolute(destination) || !paths.destinationRoots.some((r) => below(destination, r))) {
    refuse('destination: not a folder under /mnt or /media');
  }
  if (!isObject(schedule)) return refuse('schedule');
  exactKeys(schedule, ['frequency', 'time'], [], 'schedule');
  if (!['daily', 'every12h', 'every6h'].includes(String(schedule.frequency))) refuse('frequency');
  if (typeof schedule.time !== 'string' || !TIME_PATTERN.test(schedule.time)) refuse('time');
  if (!isObject(retention)) return refuse('retention');
  exactKeys(retention, ['daily', 'weekly', 'monthly'], [], 'retention');
  const count = (v: unknown, min: number, max: number) =>
    Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
  if (
    !count(retention.daily, 1, 365) ||
    !count(retention.weekly, 0, 104) ||
    !count(retention.monthly, 0, 120)
  ) {
    refuse('retention: out of range');
  }
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) refuse('items');

  const ids = new Set<string>();
  const folders = new Set<string>();
  let platforms = 0;
  for (const item of items as unknown[]) {
    if (!isObject(item)) return refuse('item: not an object');
    const { id, kind, removed } = item;
    if (typeof id !== 'string' || !UUID.test(id) || ids.has(id)) refuse('item id');
    ids.add(id as string);
    if (removed !== undefined && typeof removed !== 'boolean') refuse('item removed');
    if (kind === 'platform') {
      exactKeys(item, ['id', 'kind'], [], 'platform item');
      platforms++;
    } else if (kind === 'service') {
      exactKeys(item, ['id', 'kind', 'catalogId', 'folders'], ['removed'], 'service item');
      const catalogId = item.catalogId;
      if (typeof catalogId !== 'string' || !ID_PATTERN.test(catalogId)) refuse('catalogId');
      const recipe = loadRecipe(config, catalogId as string);
      if (!recipe) refuse(`${String(catalogId)}: no backup in its recipe`);
      if (!isObject(item.folders)) return refuse('service folders');
      const declared = new Set(recipe!.folders.map((f) => f.field));
      for (const [key, path] of Object.entries(item.folders)) {
        if (!KEY_PATTERN.test(key) || !declared.has(key)) refuse(`${key}: not a backup folder`);
        if (!absolute(path) || !allowedServiceFolder(config, path)) {
          refuse(`${key}: not an allowed folder`);
        }
        if (overlaps(path as string, destination as string)) refuse(`${key}: overlaps the disk`);
      }
      if (Object.keys(item.folders).length === 0 && removed !== true) refuse('no folders');
    } else if (kind === 'folder') {
      exactKeys(item, ['id', 'kind', 'path'], ['removed'], 'folder item');
      const path = item.path;
      if (!absolute(path) || !allowedFolder(config, path)) refuse('folder: not allowed');
      if (overlaps(path as string, destination as string)) refuse('folder: overlaps the disk');
      if (folders.has(path as string)) refuse('folder: twice');
      folders.add(path as string);
    } else {
      refuse('item kind');
    }
  }
  if (platforms !== 1) refuse('exactly one platform item');
  return raw as unknown as Plan;
}

export function exactKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[],
  what: string,
): void {
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) {
      throw new Refusal('invalid_plan', `${what}: unknown key ${key}`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new Refusal('invalid_plan', `${what}: missing ${key}`);
  }
}

export function loadPlan(config: Config, paths: Paths): Plan {
  if (!existsSync(paths.plan)) throw new Refusal('not_configured', 'no backup plan', 6);
  if (isRoot) assertRootOwned(paths.plan);
  try {
    return checkPlan(JSON.parse(readFileSync(paths.plan, 'utf8')), config, paths);
  } catch (error) {
    if (error instanceof Refusal) throw new Refusal('setup', `stored plan: ${error.message}`, 6);
    throw error;
  }
}

/** A recipe's backup section (root-owned, reviewed — still checked), or null if it has none. */
export function loadRecipe(config: Config, catalogId: string): Recipe | null {
  const file = join(config.catalogDir, catalogId, 'meta.json');
  if (!existsSync(file)) return null;
  if (isRoot) assertRootOwned(file);
  const meta = JSON.parse(readFileSync(file, 'utf8')) as {
    id?: unknown;
    fields?: { key?: unknown; type?: unknown }[];
    backup?: { folders?: { field?: unknown; skip?: unknown }[]; mode?: unknown };
  };
  const backup = meta.backup;
  if (meta.id !== catalogId || !isObject(backup)) return null;
  const pathFields = new Set(
    (Array.isArray(meta.fields) ? meta.fields : [])
      .filter((f) => f.type === 'path')
      .map((f) => f.key),
  );
  const folders = Array.isArray(backup.folders) ? backup.folders : [];
  const valid =
    (backup.mode === 'live' || backup.mode === 'stop') &&
    folders.length > 0 &&
    folders.every(
      (f) =>
        typeof f.field === 'string' &&
        KEY_PATTERN.test(f.field) &&
        pathFields.has(f.field) &&
        (f.skip === undefined ||
          (Array.isArray(f.skip) &&
            f.skip.length <= MAX_SKIPS &&
            f.skip.every((s) => typeof s === 'string' && SKIP_PATTERN.test(s)))),
    );
  if (!valid) throw new Refusal('setup', `catalog entry ${catalogId}: invalid backup section`, 6);
  return {
    mode: backup.mode as 'live' | 'stop',
    folders: folders.map((f) => ({ field: f.field as string, skip: (f.skip as string[]) ?? [] })),
  };
}
