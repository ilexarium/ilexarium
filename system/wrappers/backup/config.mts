// backup/config.mts — REVIEW-REQUIRED (system/CLAUDE.md): runs as root.
//
// The configuration (root-owned in root mode) and where this program keeps its files.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config, Paths } from './model.mts';
import { ROOT_LOCK } from '../lib/lock.mts';
import { Refusal } from '../lib/output.mts';
import { assertRootOwned, isPlainAbsolutePath } from '../lib/paths.mts';
import { isRoot } from '../lib/startup.mts';

export const ROOT_CONFIG = '/etc/laris/wrappers.json';

export const ROOT_PATHS = {
  plan: '/etc/laris/backup.json',
  repository: '/etc/laris/backup-repository.json',
  passphrase: '/etc/laris/backup.passphrase',
  state: '/var/lib/laris/backups',
  restores: '/srv/laris/restores',
  timerDropIn: '/etc/systemd/system/laris-backup.timer.d/schedule.conf',
  mountInfo: '/proc/self/mountinfo',
};

export const DESTINATION_ROOTS = ['/mnt', '/media'];

/** A scheduled run waits this long for an install to finish, then gives up until next time. */
export const LOCK_WAIT_MS = 15 * 60_000;

export const LOCK_POLL_MS = 5_000;

export const RESTART_DELAY_MS = 5_000;

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const absolute = (p: unknown): p is string =>
  typeof p === 'string' && isPlainAbsolutePath(p);

export function loadConfig(): Config {
  const path = isRoot ? ROOT_CONFIG : process.env['LARIS_WRAPPER_CONFIG'];
  if (!path) throw new Refusal('setup', 'no configuration', 6);
  if (isRoot) assertRootOwned(path);
  const config = JSON.parse(readFileSync(path, 'utf8')) as Config;
  const backup = config.backup;
  const platform = isObject(backup) ? backup.platform : undefined;
  const dev = isObject(backup) ? backup.dev : undefined;
  const name = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
  const valid =
    absolute(config.catalogDir) &&
    absolute(config.dockerBin) &&
    Array.isArray(config.storageRoots) &&
    config.storageRoots.every(absolute) &&
    Array.isArray(config.protectedPaths) &&
    config.protectedPaths.every(absolute) &&
    isObject(backup) &&
    absolute(backup.borgBin) &&
    (backup.systemctlBin === undefined || absolute(backup.systemctlBin)) &&
    (backup.appUid === undefined || Number.isInteger(backup.appUid)) &&
    (backup.appGid === undefined || Number.isInteger(backup.appGid)) &&
    isObject(platform) &&
    name.test(String(platform.container)) &&
    name.test(String(platform.database)) &&
    name.test(String(platform.user)) &&
    Array.isArray(platform.files) &&
    platform.files.every(absolute) &&
    (isRoot
      ? Number.isInteger(backup.appUid) && Number.isInteger(backup.appGid)
      : isObject(dev) &&
        absolute(dev.dir) &&
        absolute(dev.mountInfo) &&
        Array.isArray(dev.destinationRoots) &&
        dev.destinationRoots.every(absolute));
  if (!valid) throw new Refusal('setup', `invalid configuration ${path}`, 6);
  return config;
}

/** Root mode: fixed places. Development: under the config's dev folder. */
export function pathsFor(config: Config): Paths {
  if (isRoot) {
    return {
      ...ROOT_PATHS,
      lock: ROOT_LOCK,
      destinationRoots: DESTINATION_ROOTS,
      lockWaitMs: LOCK_WAIT_MS,
      retryDelayMs: RESTART_DELAY_MS,
    };
  }
  const dev = config.backup.dev!;
  return {
    plan: join(dev.dir, 'backup.json'),
    repository: join(dev.dir, 'backup-repository.json'),
    passphrase: join(dev.dir, 'backup.passphrase'),
    state: join(dev.dir, 'state'),
    restores: join(dev.dir, 'restores'),
    timerDropIn: join(dev.dir, 'systemd', 'laris-backup.timer.d', 'schedule.conf'),
    mountInfo: dev.mountInfo,
    lock: config.lockFile ?? join(dev.dir, 'compose.lock'),
    destinationRoots: dev.destinationRoots,
    lockWaitMs: dev.lockWaitMs ?? LOCK_WAIT_MS,
    retryDelayMs: dev.retryDelayMs ?? RESTART_DELAY_MS,
  };
}
