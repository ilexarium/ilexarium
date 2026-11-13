// backup/places.mts — runs as root.
//
// Which folders may be backed up, restored into or deleted — checked right before each use. Root
// reads almost anywhere: every folder but the system's and the platform's own.

import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Config } from './model.mts';
import { Refusal } from '../lib/output.mts';
import { DENIED_PATHS, inside, isPlainAbsolutePath } from '../lib/paths.mts';

export const below = (path: string, root: string) => path.startsWith(`${root}/`);

/** The folders but those inside another of them, each once (whatever holds them goes with them). */
export const outermost = (folders: string[]) =>
  [...new Set(folders)].filter((path) => !folders.some((root) => below(path, root)));

/** Not `/`, not a system or platform folder, neither inside one nor holding one. */
export function notSystem(config: Config, path: string): boolean {
  return (
    path !== '/' &&
    !DENIED_PATHS.some((denied) => inside(path, denied) || inside(denied, path)) &&
    !config.protectedPaths.some((denied) => inside(path, denied) || inside(denied, path))
  );
}

/** A folder that may be backed up or restored into. */
export const allowedFolder = (config: Config, path: string) =>
  isPlainAbsolutePath(path) && notSystem(config, path);

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
 * Every folder above `path`: not a symlink, and writable by nobody but its owner — otherwise
 * someone else could swap it for a symlink between a check and the write. (A home folder belongs
 * to its person: they could, but they could do anything with their own sudo anyway.)
 */
export function assertParentsSafe(path: string): void {
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const stat = lstatSync(parent);
    // A sticky folder of root's (/tmp): others can't rename or delete what isn't theirs in it.
    const sticky = (stat.mode & 0o1000) !== 0 && stat.uid === 0;
    if (stat.isSymbolicLink() || ((stat.mode & 0o022) !== 0 && !sticky)) {
      throw new Refusal('path_not_allowed', `${parent} can be changed by others`);
    }
    if (parent === '/') return;
  }
}

export const overlaps = (a: string, b: string) => inside(a, b) || inside(b, a);
