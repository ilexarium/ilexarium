// The configuration (root-owned in root mode), the places and the programs.

import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import type { Config, Paths, Programs } from './model.mts';
import { ROOT_LOCK } from '../lib/lock.mts';
import { Refusal } from '../lib/output.mts';
import { assertRootOwned, isPlainAbsolutePath } from '../lib/paths.mts';
import { isRoot } from '../lib/startup.mts';

export const ROOT_CONFIG = '/etc/laris/wrappers.json';
/** The machine's settings for the app (the person's: where it listens), never changed by an update. */
const APP_SETTINGS = '/etc/laris/app.env';

const SSH_UNITS = ['ssh.service', 'sshd.service'];

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
    (update.sshUnit === undefined || SSH_UNITS.includes(update.sshUnit)) &&
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
    healthUrl: isRoot || !dev ? healthUrlOf(readAppSettings()) : dev.healthUrl,
  };
}

function readAppSettings(): string {
  if (!existsSync(APP_SETTINGS)) return '';
  assertRootOwned(APP_SETTINGS);
  return readFileSync(APP_SETTINGS, 'utf8');
}

/**
 * Where the app answers, from its settings: HOST and PORT as systemd reads them (the last of
 * each, spaces and one pair of quotes taken off), the app's own defaults without them (127.0.0.1,
 * 3000); listening on every address, it answers on 127.0.0.1. Only those two values are read —
 * the file also holds the database password.
 */
export function healthUrlOf(appSettings: string): string {
  const setting = (name: string) => {
    const value =
      appSettings
        .split('\n')
        .map((line) => line.trim())
        .findLast((line) => line.startsWith(`${name}=`))
        ?.slice(name.length + 1)
        .trim() ?? '';
    return /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
  };
  const host = setting('HOST');
  const port = Number(setting('PORT') || '3000');
  if ((host !== '' && !isIP(host)) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Refusal('setup', `invalid HOST or PORT in ${APP_SETTINGS}`, 6);
  }
  const address = host === '' || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  return `http://${isIP(address) === 6 ? `[${address}]` : address}:${port}/api/health`;
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
