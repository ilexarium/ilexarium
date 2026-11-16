// lib/ownership.mts — runs as root, and in the helper as the person.
//
// Who asked for this (the kernel's word, never a request's), and whether another account could
// change a path — so whatever is read or run from it is what its owner put there.

import { lstatSync, readFileSync, realpathSync, type Stats } from 'node:fs';
import { dirname } from 'node:path';

/** This process and the ones above it, up to the first not running as root (by its real uid). */
function processesAbove(): { pid: number; parent: number; uid: number }[] {
  const chain: { pid: number; parent: number; uid: number }[] = [];
  for (let pid = process.pid; pid > 0;) {
    let status: string;
    try {
      status = readFileSync(`/proc/${pid}/status`, 'utf8');
    } catch {
      return [];
    }
    const parent = Number(/^PPid:\s+(\d+)$/m.exec(status)?.[1] ?? 0);
    const uid = Number(/^Uid:\s+(\d+)\s/m.exec(status)?.[1] ?? 0);
    chain.push({ pid, parent, uid });
    if (uid !== 0) break;
    pid = parent;
  }
  return chain;
}

/**
 * The account whose sudo started this process: the first process above it not running as root
 * (sudo, or the helper that ran it) — this account itself when it isn't root. Started by root
 * itself, or a process above ended while read: root.
 */
export function askingUid(): number {
  const first = processesAbove();
  // Read twice: a process above that ended (its pid free for anyone's) changed its child's parent.
  if (JSON.stringify(first) !== JSON.stringify(processesAbove())) return 0;
  return first.at(-1)?.uid ?? 0;
}

const records = (path: string) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split(':'));

/**
 * Whether a group holds an account but `uids`' (the owner and the asker): a member listed in
 * /etc/group, or an account whose own group it is. A person's private group (Debian's and
 * Ubuntu's default, with a umask of 002 — so their folders are group-writable) holds only them.
 * Unreadable: assume it does.
 */
export function groupHasOthers(
  gid: number,
  uids: number[],
  files = { passwd: '/etc/passwd', group: '/etc/group' },
): boolean {
  try {
    const users = records(files.passwd);
    const allowed = users.filter((fields) => uids.includes(Number(fields[2]))).map((f) => f[0]);
    const members = records(files.group)
      .filter((fields) => Number(fields[2]) === gid)
      .flatMap((fields) => (fields[3] ?? '').split(',').filter(Boolean));
    const ownGroup = users.filter((fields) => Number(fields[3]) === gid).map((f) => f[0]);
    return [...members, ...ownGroup].some((name) => !allowed.includes(name));
  } catch {
    return true;
  }
}

/**
 * Could an account other than `askedBy` (or root) change this: it's a symlink, belongs to someone
 * else, or others — or a group with someone else in it — may write in it. A sticky folder of
 * root's (/tmp) counts only further up (`above`): others can't rename or delete what isn't theirs
 * in it.
 */
export function othersCanChange(stat: Stats, askedBy: number, above: boolean): boolean {
  if (stat.isSymbolicLink() || (stat.uid !== 0 && stat.uid !== askedBy)) return true;
  if (above && stat.uid === 0 && (stat.mode & 0o1000) !== 0) return false;
  if ((stat.mode & 0o002) !== 0) return true;
  return (stat.mode & 0o020) !== 0 && groupHasOthers(stat.gid, [stat.uid, askedBy]);
}

/**
 * Whether someone else could change a folder above: a symlink only through the folder holding
 * it (nobody can change a link itself), which comes next.
 */
function parentChangeable(parent: string, askedBy: number): boolean {
  const stat = lstatSync(parent, { throwIfNoEntry: false });
  return !!stat && !stat.isSymbolicLink() && othersCanChange(stat, askedBy, true);
}

/**
 * The first of `path` (never itself a symlink), the folders above it — as written, and where
 * they really are once links are resolved — and `files` in it (those that are there) another
 * account could change, or a missing `path`; null when there's none.
 */
export function changeableByOthers(path: string, files: string[], askedBy: number): string | null {
  const own = lstatSync(path, { throwIfNoEntry: false });
  if (!own || othersCanChange(own, askedBy, false)) return path;
  const real = realpathSync(path);
  for (const start of new Set([path, real])) {
    for (let parent = dirname(start); ; parent = dirname(parent)) {
      if (parentChangeable(parent, askedBy)) return parent;
      if (parent === '/') break;
    }
  }
  for (const file of files) {
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (stat && othersCanChange(stat, askedBy, false)) return file;
  }
  return null;
}
