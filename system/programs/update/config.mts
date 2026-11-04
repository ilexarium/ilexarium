// The configuration (root-owned in root mode), the places and the programs.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config, Paths, Programs } from './model.mts';
import { ROOT_LOCK } from '../lib/lock.mts';
import { Refusal } from '../lib/output.mts';
import { assertRootOwned, isPlainAbsolutePath } from '../lib/paths.mts';
import { isRoot } from '../lib/startup.mts';

export const ROOT_CONFIG = '/etc/laris/wrappers.json';

const absolute = (p: unknown): p is string => typeof p === 'string' && isPlainAbsolutePath(p);

export function loadConfig(): Config {
  const path = isRoot ? ROOT_CONFIG : process.env['LARIS_WRAPPER_CONFIG'];
  if (!path) throw new Refusal('setup', 'no configuration', 6);
  if (isRoot) assertRootOwned(path);
  const config = JSON.parse(readFileSync(path, 'utf8')) as Partial<Config>;
  const update = config.update;
  const dev = update?.dev;
  const valid =
    typeof update === 'object' &&
    update !== null &&
    (isRoot
      ? Number.isInteger(update.appGid)
      : typeof dev === 'object' &&
        dev !== null &&
        absolute(dev.root) &&
        absolute(dev.bin) &&
        typeof dev.healthUrl === 'string');
  if (!valid) throw new Refusal('setup', `invalid configuration ${path}`, 6);
  return config as Config;
}

export function pathsFor(config: Config): Paths {
  const dev = config.update.dev;
  const under = (path: string) => (isRoot || !dev ? path : join(dev.root, path));
  return {
    etc: under('/etc/laris'),
    opt: under('/opt/laris'),
    state: under('/var/lib/laris/updates'),
    installBackups: under('/var/lib/laris/install-backups'),
    units: under('/etc/systemd/system'),
    host: isRoot || !dev ? '/' : dev.root,
    lock: isRoot || !dev ? ROOT_LOCK : join(dev.root, 'root.lock'),
    healthUrl: isRoot || !dev ? 'http://127.0.0.1:3000/api/health' : dev.healthUrl,
  };
}

export function programsFor(config: Config): Programs {
  const dev = config.update.dev;
  const program = (path: string) => (isRoot || !dev ? path : join(dev.bin, path.split('/').pop()!));
  return {
    systemctl: program('/usr/bin/systemctl'),
    tmpfiles: program('/usr/bin/systemd-tmpfiles'),
    tar: program('/usr/bin/tar'),
    bash: program('/usr/bin/bash'),
    cp: program('/usr/bin/cp'),
    docker: program('/usr/bin/docker'),
  };
}
