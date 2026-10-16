import {
  BACKUP_DESTINATION_ROOTS,
  BACKUP_REPOSITORY_FOLDER,
  isPlainAbsolutePath,
} from '@homelab/shared';
import type { WrapperConfig } from '../executor/executor.model.js';

/**
 * Where things may be, as the app checks them — friendly errors before anything runs. The backup
 * wrapper checks all of it again, with its own code (system/wrappers/homelab-backup.mts).
 */

/** Never backed up, whatever is configured. */
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

/** The production places of the wrapper's files (development: under the config's dev folder). */
const STATE_DIR = '/var/lib/homelab/backups';
const MOUNT_INFO = '/proc/self/mountinfo';

export const inside = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

/** Not a system folder, not the platform's own, neither inside one nor holding one. */
export function notSystem(config: WrapperConfig, path: string): boolean {
  return (
    path !== '/' &&
    !DENIED_PATHS.some((denied) => inside(path, denied) || inside(denied, path)) &&
    !config.protectedPaths.some((denied) => inside(path, denied) || inside(denied, path))
  );
}

/** A service's folder: inside a storage root. */
export function isAllowedServiceFolder(config: WrapperConfig, path: string): boolean {
  return (
    isPlainAbsolutePath(path) &&
    config.storageRoots.some((root) => inside(path, root)) &&
    notSystem(config, path)
  );
}

/** `/home/<name>` or below. */
export const isHomeFolder = (path: string) => /^\/home\/[^/]+(\/|$)/.test(path);

/** A folder the user may add: inside a storage root or a home folder. */
export function isAllowedFolder(config: WrapperConfig, path: string): boolean {
  return (
    isPlainAbsolutePath(path) &&
    (config.storageRoots.some((root) => inside(path, root)) || isHomeFolder(path)) &&
    notSystem(config, path)
  );
}

/** Where backup disks may be mounted (development: the pretend ones). */
export function destinationRoots(config: WrapperConfig): string[] {
  return config.backup?.dev?.destinationRoots ?? [...BACKUP_DESTINATION_ROOTS];
}

/** A mount point strictly below one of the destination roots. */
export function isDestinationPath(config: WrapperConfig, path: string): boolean {
  return (
    isPlainAbsolutePath(path) &&
    destinationRoots(config).some((root) => path.startsWith(`${root}/`))
  );
}

export const repositoryPath = (destination: string) => `${destination}/${BACKUP_REPOSITORY_FOLDER}`;

/** The mount table the wrapper reads. */
export function mountInfoFile(config: WrapperConfig): string {
  return config.backup?.dev?.mountInfo ?? MOUNT_INFO;
}

/** The wrapper's state folder: runs.jsonl and current.jsonl, readable by the app. */
export function stateDir(config: WrapperConfig): string {
  const dev = config.backup?.dev?.dir;
  return dev ? `${dev}/state` : STATE_DIR;
}

/** An archive's time, from its name (`<item id>-<UTC time>`). */
export function archiveTime(name: string): string {
  return `${name.slice(37)}.000Z`;
}
