// process/config.mts — REVIEW-REQUIRED (system/CLAUDE.md): runs as root.
//
// The configuration (root-owned in root mode) and where /proc is.

import { readFileSync } from 'node:fs';
import type { Config } from './model.mts';
import { Refusal } from '../lib/output.mts';
import { assertRootOwned, isPlainAbsolutePath } from '../lib/paths.mts';
import { isRoot } from '../lib/startup.mts';

export const ROOT_CONFIG = '/etc/laris/wrappers.json';
export const DEFAULT_MIN_UID = 1000;
/** People's accounts end here (`UID_MAX`); above it `nobody` (65534) and the like. */
export const MAX_UID = 60000;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const uid = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

export function loadConfig(): Config {
  const path = isRoot ? ROOT_CONFIG : process.env['LARIS_WRAPPER_CONFIG'];
  if (!path) throw new Refusal('setup', 'no configuration', 6);
  if (isRoot) assertRootOwned(path);
  const config = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const section = config['process'];
  const dev = isObject(section) ? section['dev'] : undefined;
  const valid =
    isObject(section) &&
    (section['appUid'] === undefined || uid(section['appUid'])) &&
    (section['minUid'] === undefined || (uid(section['minUid']) && section['minUid'] >= 1)) &&
    (isRoot
      ? // As root: the app's own user must be known, and /proc is the real one.
        uid(section['appUid']) && dev === undefined
      : isObject(dev) &&
        typeof dev['procRoot'] === 'string' &&
        isPlainAbsolutePath(dev['procRoot']));
  if (!valid) throw new Refusal('setup', `invalid configuration ${path}`, 6);
  return config as unknown as Config;
}

/** /proc — in development the folder the config names. */
export function procRoot(config: Config): string {
  return isRoot ? '/proc' : config.process.dev!.procRoot;
}

export function minUid(config: Config): number {
  return config.process.minUid ?? DEFAULT_MIN_UID;
}
