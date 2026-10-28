// lib/paths.mts — REVIEW-REQUIRED (system/CLAUDE.md): runs as root.
//
// Paths: their plain form, the folders never touched, and the root-owned check for files this
// program trusts.

import { lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { Refusal } from './output.mts';

export const SAFE_PATH = '/usr/sbin:/usr/bin:/sbin:/bin';

export const PATH_FORBIDDEN = /[\x00-\x1f\x7f]/;

export const PATH_MAX = 1024;

/** Never a source or a restore target, whatever the config says. */
export const DENIED_PATHS = [
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
  '/var/lib/laris',
  '/var/run',
  '/opt/laris',
];

export function isPlainAbsolutePath(path: string): boolean {
  if (!path.startsWith('/') || path.length > PATH_MAX || PATH_FORBIDDEN.test(path)) return false;
  if (path === '/') return true;
  return path
    .slice(1)
    .split('/')
    .every((s) => s !== '' && s !== '.' && s !== '..');
}

export const inside = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

/** The path and every folder above it: owned by root, not writable by group or others. */
export function assertRootOwned(path: string): void {
  for (let current = path; ; current = dirname(current)) {
    const stat = lstatSync(current);
    if (stat.uid !== 0 || (stat.mode & 0o022) !== 0 || stat.isSymbolicLink()) {
      throw new Refusal('setup', `${current} must belong to root and be writable only by root`, 6);
    }
    if (current === '/') return;
  }
}
