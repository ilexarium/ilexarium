import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SERVICE_ERROR_CODES, type ServiceErrorCode } from '@homelab/shared';
import type { WrapperConfig } from '../executor/executor.model.js';

/**
 * The app's friendly pre-checks of ports and folders, so the form can show "port in use" on the
 * right field before anything runs. The root wrapper checks the same things again, for real —
 * these only read files (no commands) and may be wrong in edge cases; the wrapper decides.
 */

/** Never mounted, whatever the config says (the wrapper keeps the same list). */
const DENIED_PATHS = [
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/lib',
  '/lib32',
  '/lib64',
  '/proc',
  '/root',
  '/run',
  '/sbin',
  '/sys',
  '/usr',
  '/var/lib/docker',
  '/var/run',
];

const inside = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

/** TCP ports something listens on (IPv4 and IPv6), from /proc/net. */
export function listeningPorts(): Set<number> {
  const ports = new Set<number>();
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n').slice(1)) {
      const columns = line.trim().split(/\s+/);
      if (columns[3] === '0A') ports.add(parseInt(columns[1].split(':')[1], 16));
    }
  }
  return ports;
}

export function checkPort(
  port: number,
  config: WrapperConfig,
  taken: ReadonlySet<number>,
): ServiceErrorCode | null {
  if (config.reservedPorts.includes(port)) return SERVICE_ERROR_CODES.portReserved;
  if (taken.has(port)) return SERVICE_ERROR_CODES.portInUse;
  return null;
}

/** Inside a storage root, not a system or platform folder, and existing — or the service's own (created on deploy). */
export function checkFolder(
  path: string,
  catalogId: string,
  config: WrapperConfig,
): ServiceErrorCode | null {
  const allowed =
    path !== '/' &&
    config.storageRoots.some((root) => inside(path, root)) &&
    !DENIED_PATHS.some((denied) => inside(path, denied) || inside(denied, path)) &&
    !config.protectedPaths.some((p) => inside(path, p) || inside(p, path));
  if (!allowed) return SERVICE_ERROR_CODES.pathNotAllowed;
  const own = join(config.serviceRoot, catalogId);
  if (inside(path, own) && path !== own) return null;
  try {
    return statSync(path).isDirectory() ? null : SERVICE_ERROR_CODES.pathNotFound;
  } catch (error) {
    // Not readable by the app (e.g. another user's folder): leave it to the wrapper.
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? SERVICE_ERROR_CODES.pathNotFound
      : null;
  }
}

/** A folder default written for /srv/homelab, moved to this machine's service root. */
export function localFolder(path: string, config: WrapperConfig): string {
  const standard = '/srv/homelab';
  return inside(path, standard) ? config.serviceRoot + path.slice(standard.length) : path;
}
