// backup/places.mts — runs as root.
//
// Which folders may be backed up, restored into or deleted — checked right before each use. Root
// reads almost anywhere: every folder but the system's and the platform's own; it writes only
// below folders nobody but root and the person who asked can change.

import { existsSync, lstatSync, realpathSync, type Stats } from 'node:fs';
import { dirname } from 'node:path';
import type { Config } from './model.mts';
import { Refusal } from '../lib/output.mts';
import { askingUid } from '../lib/ownership.mts';
import { DENIED_PATHS, inside, isPlainAbsolutePath } from '../lib/paths.mts';
import { isRoot } from '../lib/startup.mts';

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
 * Who asked for this: the account whose sudo started it — the first process above this one not
 * running as root (sudo, or the helper that ran it). The kernel says so, not the app, which only
 * sends the helper JSON. Started by root itself, or a process above ended while read: root.
 * Development: this account, or the config's `dev.askedBy` (the tests).
 */
export function askingAccount(config: Config): number {
  if (!isRoot) return config.backup.dev?.askedBy ?? process.getuid?.() ?? 0;
  return askingUid();
}

/**
 * May root create, rename, delete or extract right below this folder: it isn't a symlink, it
 * belongs to root or to the person who asked (who can do anything as root anyway), and nobody
 * else may write in it. Then nobody else can swap it, or a folder in it, for a symlink between a
 * check and the write — which is what makes checking by path enough: Borg writes by path for as
 * long as the extract takes. A sticky folder of root's (/tmp) counts only further up (`above`):
 * others can't rename or delete what isn't theirs in it, but could take a name root makes in it.
 */
function othersCanChange(stat: Stats, askedBy: number, above: boolean): boolean {
  const sticky = above && stat.uid === 0 && (stat.mode & 0o1000) !== 0;
  return (
    stat.isSymbolicLink() ||
    (stat.uid !== 0 && stat.uid !== askedBy) ||
    ((stat.mode & 0o022) !== 0 && !sticky)
  );
}

const othersRefusal = (path: string) =>
  new Refusal('path_others_can_change', `${path} can be changed by another account`);

/** Every folder above `path` that is there (a missing one root makes, inside the next one up). */
export function assertParentsSafe(path: string, askedBy: number): void {
  let above = false;
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const stat = lstatSync(parent, { throwIfNoEntry: false });
    if (stat) {
      if (othersCanChange(stat, askedBy, above)) throw othersRefusal(parent);
      above = true;
    }
    if (parent === '/') return;
  }
}

/** A folder root writes into itself (a restore's target). */
export function assertSafeFolder(path: string, askedBy: number): void {
  if (othersCanChange(lstatSync(path), askedBy, false)) throw othersRefusal(path);
}

export const overlaps = (a: string, b: string) => inside(a, b) || inside(b, a);
