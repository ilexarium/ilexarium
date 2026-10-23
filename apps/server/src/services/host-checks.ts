import { join } from 'node:path';
import { SERVICE_ERROR_CODES, type ServiceErrorCode } from '@laris/shared';
import type { WrapperConfig } from '../executor/executor.model.js';
import type { FolderState } from '../host/host.model.js';
import { SYSTEM_FOLDERS } from '../host/host.constants.js';

/**
 * The app's friendly pre-checks of ports and folders, so the form can show "port in use" on the
 * right field before anything runs. Decisions only: what the host looks like comes from the
 * `SystemReader` (`host/`). The root wrapper checks the same things again, for real — these may be
 * wrong in edge cases; the wrapper decides.
 */

const inside = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

export function checkPort(
  port: number,
  config: WrapperConfig,
  taken: ReadonlySet<number>,
): ServiceErrorCode | null {
  if (config.reservedPorts.includes(port)) return SERVICE_ERROR_CODES.portReserved;
  if (taken.has(port)) return SERVICE_ERROR_CODES.portInUse;
  return null;
}

/** Where a folder may be: inside a storage root, never a system or platform folder (nor containing one). */
export function folderAllowed(path: string, config: WrapperConfig): boolean {
  return (
    path !== '/' &&
    config.storageRoots.some((root) => inside(path, root)) &&
    !SYSTEM_FOLDERS.some((denied) => inside(path, denied) || inside(denied, path)) &&
    !config.protectedPaths.some((p) => inside(path, p) || inside(p, path))
  );
}

/** A folder inside the service's own area (`<serviceRoot>/<id>/…`): created on deploy if missing. */
export function inServiceArea(path: string, catalogId: string, config: WrapperConfig): boolean {
  const own = join(config.serviceRoot, catalogId);
  return inside(path, own) && path !== own;
}

/** The pre-check's answer for a folder, given what is there (`SystemReader.folder`). */
export function checkFolder(
  path: string,
  catalogId: string,
  config: WrapperConfig,
  state: FolderState,
): ServiceErrorCode | null {
  if (!folderAllowed(path, config)) return SERVICE_ERROR_CODES.pathNotAllowed;
  if (inServiceArea(path, catalogId, config)) return null;
  // Not readable by the app (e.g. another user's folder): leave it to the wrapper.
  if (state === 'folder' || state === 'unreadable') return null;
  return SERVICE_ERROR_CODES.pathNotFound;
}

/** A folder default written for /srv/laris, moved to this machine's service root. */
export function localFolder(path: string, config: WrapperConfig): string {
  const standard = '/srv/laris';
  return inside(path, standard) ? config.serviceRoot + path.slice(standard.length) : path;
}
