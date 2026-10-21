// lib/lock.mts — REVIEW-REQUIRED (system/CLAUDE.md): runs as root.
//
// One privileged operation at a time: the lock both wrappers share.

import {
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

/** The lock both wrappers take: one privileged operation at a time, installs and backups alike. */
export const ROOT_LOCK = '/run/laris/compose.lock';

/** Takes the lock, or null while another operation holds it. Returns its release. */
export function tryLock(path: string): (() => void) | null {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Created whole: the pid written to a file of our own, then linked into place — the lock never
  // exists empty, so nobody can mistake a lock being taken for a dead one.
  const own = `${path}.${process.pid}`;
  writeFileSync(own, String(process.pid), { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        linkSync(own, path);
        return () => {
          try {
            unlinkSync(path);
          } catch {
            // already gone
          }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const holder = lockHolder(path);
        if (holder.alive) return null;
        // Its owner died: take it over — only the lock judged dead, never one taken meanwhile.
        try {
          if (lstatSync(path).ino === holder.ino) unlinkSync(path);
        } catch {
          // already gone
        }
      }
    }
    return null;
  } finally {
    rmSync(own, { force: true });
  }
}

/** Whether a lock's owner lives (one without a pid — an older writer — counts for a minute). */
export function lockHolder(path: string): { alive: boolean; ino: number } {
  let stat;
  let text;
  try {
    stat = lstatSync(path);
    text = readFileSync(path, 'utf8');
  } catch {
    return { alive: false, ino: -1 };
  }
  const pid = Number(text);
  if (Number.isInteger(pid) && pid > 0) return { alive: alive(pid), ino: stat.ino };
  return { alive: Date.now() - stat.mtimeMs < 60_000, ino: stat.ino };
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
