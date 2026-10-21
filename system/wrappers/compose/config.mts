// compose/config.mts — REVIEW-REQUIRED (system/CLAUDE.md): runs as root.
//
// The configuration (root-owned in root mode).

import { readFileSync } from 'node:fs';
import { Refusal } from '../lib/output.mts';
import { assertRootOwned, isPlainAbsolutePath } from '../lib/paths.mts';
import { isRoot } from '../lib/startup.mts';

export const ROOT_CONFIG = '/etc/laris/wrappers.json';

export interface Config {
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

export function loadConfig(): Config {
  const path = isRoot ? ROOT_CONFIG : process.env['LARIS_WRAPPER_CONFIG'];
  if (!path) throw new Refusal('setup', 'no configuration', 6);
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
    throw new Refusal('setup', `invalid configuration ${path}`, 6);
  }
  return config;
}
