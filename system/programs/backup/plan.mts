// backup/plan.mts — runs as root.
//
// The plan (from the app through `configure`; re-checked whenever it's read).

import { existsSync, readFileSync } from 'node:fs';
import { absolute, isObject } from './config.mts';
import { destinationAllowed } from './destination.mts';
import type { Config, Paths, Plan } from './model.mts';
import { allowedFolder, overlaps } from './places.mts';
import { Refusal } from '../lib/output.mts';
import { assertRootOwned } from '../lib/paths.mts';
import { isRoot } from '../lib/startup.mts';

export const MAX_ITEMS = 100;

export const MAX_SKIPS = 20;

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A Compose project's name (an app's). */
export const PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export const MAX_FOLDERS = 30;

export const TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export const ARCHIVE_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

/**
 * A skip, below its folder: one or more names, none "." or "..", no leading "-", `*` and `?`
 * within a name, never "[", "]" or "\\" (they'd read as more of a pattern).
 */
export const SKIP_PATTERN =
  /^(?![/-])(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*\/$)[^\x00-\x1f\x7f\\[\]]{1,255}$/;

/** A skip, absolute: inside one of the folders. */
export function skipAllowed(skip: unknown, folders: string[]): boolean {
  if (typeof skip !== 'string' || skip.length > 1024) return false;
  const folder = folders.find((f) => skip.startsWith(`${f}/`));
  return folder !== undefined && SKIP_PATTERN.test(skip.slice(folder.length + 1));
}

export function checkPlan(raw: unknown, config: Config, paths: Paths): Plan {
  const refuse = (why: string): never => {
    throw new Refusal('invalid_plan', why);
  };
  if (!isObject(raw)) return refuse('not an object');
  exactKeys(raw, ['destination', 'schedule', 'retention', 'items'], [], 'plan');
  const { destination, schedule, retention, items } = raw;
  if (!destinationAllowed(config, paths, destination)) refuse('destination');
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
    } else if (kind === 'app') {
      exactKeys(
        item,
        ['id', 'kind', 'project', 'folders', 'skip', 'mode'],
        ['removed'],
        'app item',
      );
      const { project, folders: own, skip, mode } = item;
      if (typeof project !== 'string' || !PROJECT_PATTERN.test(project)) refuse('project');
      if (mode !== 'stop' && mode !== 'live') refuse('mode');
      if (!Array.isArray(own) || own.length > MAX_FOLDERS) return refuse('app folders');
      if (own.length === 0 && removed !== true) refuse('no folders');
      for (const path of own) {
        if (!absolute(path) || !allowedFolder(config, path)) refuse('app folder: not allowed');
        if (overlaps(path as string, destination as string))
          refuse('app folder: overlaps the disk');
      }
      if (new Set(own).size !== own.length) refuse('app folder: twice');
      if (!Array.isArray(skip) || skip.length > MAX_SKIPS) return refuse('skip');
      if (!skip.every((one) => skipAllowed(one, own as string[]))) refuse('skip: not in a folder');
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

/** The stored plan, checked again. */
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
