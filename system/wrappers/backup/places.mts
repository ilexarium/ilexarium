// backup/places.mts — REVIEW-REQUIRED (system/CLAUDE.md): runs as root.
//
// Which folders may be backed up, restored into or deleted — checked right before each use.

import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Config } from './model.mts';
import { Refusal } from '../lib/output.mts';
import { DENIED_PATHS, inside, isPlainAbsolutePath } from '../lib/paths.mts';
import { isRoot } from '../lib/startup.mts';

export const below = (path: string, root: string) => path.startsWith(`${root}/`);

/**
 * The restore area (set at start): never backed up, never a service's folder — a restored
 * platform backup holds the master key and the database dump.
 */

export let restoreArea: string | null = null;

export function setRestoreArea(path: string): void {
  restoreArea = path;
}

export function notSystem(config: Config, path: string): boolean {
  return (
    path !== '/' &&
    (restoreArea === null || !(inside(path, restoreArea) || inside(restoreArea, path))) &&
    !DENIED_PATHS.some((denied) => inside(path, denied) || inside(denied, path)) &&
    !config.protectedPaths.some((denied) => inside(path, denied) || inside(denied, path))
  );
}

/** A service's folder: inside a storage root, never a system or platform folder. */
export const allowedServiceFolder = (config: Config, path: string) =>
  config.storageRoots.some((root) => inside(path, root)) && notSystem(config, path);

/** A chosen folder: a service folder's places, or a home folder (`/home/<name>` and below). */
export const allowedFolder = (config: Config, path: string) =>
  (allowedServiceFolder(config, path) || /^\/home\/[^/]+(\/|$)/.test(path)) &&
  notSystem(config, path);

/**
 * A source, right before it's read: it exists, is a folder, isn't itself a symlink, and is still
 * in an allowed place once every symlink above it is resolved. Borg stores symlinks inside it as
 * links (never follows them), so a link can't pull another folder in.
 */

export function resolveSource(path: string, allowed: (p: string) => boolean): string | null {
  if (!isPlainAbsolutePath(path) || !allowed(path)) return null;
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
  const real = realpathSync(path);
  return allowed(real) ? real : null;
}

/**
 * Every folder above `path` (from `stopAt` in development): not a symlink and writable by no one
 * but root (development: root or this user) — otherwise it could be swapped for a symlink between
 * a check and the write.
 */

export function assertParentsSafe(path: string, devStopAt: string[]): void {
  const me = process.getuid?.() ?? 0;
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    if (!isRoot && !devStopAt.some((root) => inside(parent, root))) return;
    const stat = lstatSync(parent);
    const owner = stat.uid === 0 || (!isRoot && stat.uid === me);
    if (stat.isSymbolicLink() || !owner || (stat.mode & 0o022) !== 0) {
      throw new Refusal('path_not_allowed', `${parent} is writable by others than root`);
    }
    if (parent === '/') return;
  }
}

export const overlaps = (a: string, b: string) => inside(a, b) || inside(b, a);
