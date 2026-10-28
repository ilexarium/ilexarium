// backup/destination.mts — REVIEW-REQUIRED (system/CLAUDE.md): runs as root.
//
// The destination disk and the repositories this program set up.

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SYSTEM_MOUNTS, absolute, isObject } from './config.mts';
import { writeAtomic } from './files.mts';
import type { Config, Paths, Plan, Repository } from './model.mts';
import { below, notSystem } from './places.mts';
import { Refusal } from '../lib/output.mts';
import { assertRootOwned, inside } from '../lib/paths.mts';
import { isRoot } from '../lib/startup.mts';

export const REPOSITORY_FOLDER = 'laris-backups';

export const FILESYSTEMS = new Set(['ext4', 'btrfs', 'xfs', 'exfat']);

/** The mount points in a mountinfo file, with their file system types (the last mount wins). */
export function mounts(file: string): Map<string, string> {
  const result = new Map<string, string>();
  const unescape = (s: string) =>
    s.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const [before, after] = line.split(' - ');
    if (!after) continue;
    const mountPoint = before.split(' ')[4];
    const type = after.split(' ')[0];
    if (mountPoint && type) result.set(unescape(mountPoint), type);
  }
  return result;
}

/**
 * The chosen disk, before anything is written to it: a plain folder that isn't a system one,
 * really a mount point (else a run would fill the system disk) but not one of the system's own,
 * of a supported format, and nothing on the way to it writable by the app (its user, its group)
 * or by everyone.
 */
export function checkDestination(config: Config, paths: Paths, destination: string): void {
  const refuse = (why: string): never => {
    throw new Refusal('destination_unavailable', `${destination}: ${why}`, 5);
  };
  const roots = paths.destinationRoots;
  const allowed = roots
    ? roots.some((r) => below(destination, r))
    : notSystem(config, destination) && !SYSTEM_MOUNTS.includes(destination);
  if (!absolute(destination) || !allowed) {
    throw new Refusal('destination_not_allowed', 'not a disk that may hold backups');
  }
  if (!existsSync(destination)) refuse('not there');
  if (realpathSync(destination) !== destination) refuse('reached through a symlink');
  const type = mounts(paths.mountInfo).get(destination);
  if (type === undefined) refuse('not a mounted disk');
  if (!FILESYSTEMS.has(type!)) refuse(`a ${type} disk is not supported`);
  const { appUid, appGid } = config.backup;
  for (let current = destination; ; current = dirname(current)) {
    if (!isRoot && !roots?.some((root) => inside(current, root))) break;
    const stat = lstatSync(current);
    const writable =
      stat.isSymbolicLink() ||
      (stat.mode & 0o002) !== 0 ||
      (appUid !== undefined && stat.uid === appUid) ||
      (appGid !== undefined && stat.gid === appGid && (stat.mode & 0o020) !== 0);
    if (writable) refuse(`${current} can be changed by the app or by everyone`);
    if (current === '/') break;
  }
}

/** A Borg repository's id, from its config file (root-only; read as root). */
export function repositoryId(path: string): string | null {
  const file = join(path, 'config');
  if (!existsSync(file)) return null;
  const match = /^id\s*=\s*([0-9a-f]{64})\s*$/m.exec(readFileSync(file, 'utf8'));
  return match ? match[1] : null;
}

/**
 * The repositories this program set up, by path (one per disk used): switching disks adds one,
 * so a plan change refused after `init` never leaves the plan's disk without its record.
 * Reads the first version's single `{ path, id }` too.
 */
export function loadRepositories(paths: Paths): Repository[] {
  if (!existsSync(paths.repository)) return [];
  if (isRoot) assertRootOwned(paths.repository);
  const raw = JSON.parse(readFileSync(paths.repository, 'utf8')) as
    { repositories?: unknown } | Repository;
  const list = 'repositories' in raw ? raw.repositories : [raw];
  const valid = (r: unknown): r is Repository =>
    isObject(r) && absolute(r.path) && typeof r.id === 'string' && /^[0-9a-f]{64}$/.test(r.id);
  if (!Array.isArray(list) || !list.every(valid)) {
    throw new Refusal('setup', 'invalid repository file', 6);
  }
  return list;
}

export function saveRepository(paths: Paths, repo: Repository): void {
  const others = loadRepositories(paths).filter((r) => r.path !== repo.path);
  const repositories = [...others, repo];
  writeAtomic(paths.repository, `${JSON.stringify({ repositories }, null, 2)}\n`, 0o600);
}

/**
 * Before every run, restore or deletion: the plan's disk is mounted, and the repository there is
 * ours (the id stored at setup). Otherwise nothing is written — a repository is never created
 * here, only by `init`.
 */
export function openRepository(config: Config, paths: Paths, plan: Plan): Repository {
  checkDestination(config, paths, plan.destination);
  const expected = join(plan.destination, REPOSITORY_FOLDER);
  const repo = loadRepositories(paths).find((r) => r.path === expected);
  if (!repo) {
    throw new Refusal('repository_mismatch', 'no repository was set up on this disk', 5);
  }
  if (!existsSync(expected) || lstatSync(expected).isSymbolicLink()) {
    throw new Refusal('repository_mismatch', 'the repository is missing', 5);
  }
  if (repositoryId(expected) !== repo.id) {
    throw new Refusal('repository_mismatch', 'the repository on this disk is not ours', 5);
  }
  if (!existsSync(paths.passphrase)) {
    throw new Refusal('passphrase_invalid', 'the passphrase file is missing', 6);
  }
  return repo;
}
