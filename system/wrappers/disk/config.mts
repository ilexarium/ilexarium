// disk/config.mts — REVIEW-REQUIRED (system/CLAUDE.md): runs as root.
//
// The configuration (root-owned in root mode) and where this program reads and writes.

import { readFileSync } from 'node:fs';
import type { Config, Paths } from './model.mts';
import { ROOT_LOCK } from '../lib/lock.mts';
import { Refusal } from '../lib/output.mts';
import { assertRootOwned, isPlainAbsolutePath } from '../lib/paths.mts';
import { isRoot } from '../lib/startup.mts';

export const ROOT_CONFIG = '/etc/homelab/wrappers.json';

export const ROOT_PATHS = {
  host: '/',
  mountRoot: '/mnt',
  unitDir: '/etc/systemd/system',
  backupPlan: '/etc/homelab/backup.json',
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const absolute = (p: unknown): p is string => typeof p === 'string' && isPlainAbsolutePath(p);

export function loadConfig(): Config {
  const path = isRoot ? ROOT_CONFIG : process.env['HOMELAB_WRAPPER_CONFIG'];
  if (!path) throw new Refusal('setup', 'no configuration', 6);
  if (isRoot) assertRootOwned(path);
  const config = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const disk = config['disk'];
  const dev = isObject(disk) ? disk['dev'] : undefined;
  const valid =
    isObject(disk) &&
    (disk['systemctlBin'] === undefined || absolute(disk['systemctlBin'])) &&
    (isRoot
      ? absolute(disk['systemctlBin'])
      : isObject(dev) &&
        absolute(dev['root']) &&
        absolute(dev['mountRoot']) &&
        absolute(dev['unitDir']) &&
        absolute(dev['backupPlan']));
  if (!valid) throw new Refusal('setup', `invalid configuration ${path}`, 6);
  return config as unknown as Config;
}

/** Root mode: fixed places. Development: the pretend host and folders the config names. */
export function pathsFor(config: Config): Paths {
  if (isRoot) return { ...ROOT_PATHS, lock: ROOT_LOCK };
  const dev = config.disk.dev!;
  return {
    host: dev.root,
    mountRoot: dev.mountRoot,
    unitDir: dev.unitDir,
    backupPlan: dev.backupPlan,
    lock: `${dev.unitDir}.lock`,
  };
}
