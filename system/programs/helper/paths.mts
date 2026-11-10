// Folders: their sizes (the removal dialog) and deleting them (a removal's ticked folders) — as
// this account, or by ilex-root for what containers wrote as another user.

import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  BAD_REQUEST,
  inside,
  ok,
  plainPath,
  refused,
  said,
  type Answer,
  type Request,
} from './answers.mts';
import { run } from './run.mts';
import {
  LONG_TIMEOUT_MS,
  NEVER_REMOVED,
  NEVER_REMOVED_BELOW,
  PATHS_MAX,
  PROGRAMS,
} from './config.mts';

function paths(request: Request): string[] | null {
  const list = request['paths'];
  if (!Array.isArray(list) || list.length === 0 || list.length > PATHS_MAX) return null;
  return list.every(plainPath) ? (list as string[]) : null;
}

/** A folder never deleted: the system's own, or a top folder like /home or /srv. */
export function protectedPath(path: string): boolean {
  return (
    NEVER_REMOVED.includes(path) ||
    /^\/home\/[^/]+$/.test(path) ||
    NEVER_REMOVED_BELOW.some((root) => inside(path, root))
  );
}

/** Sizes in bytes (`du`); a folder it couldn't read all of is still counted, marked partial. */
export async function pathSizes(request: Request): Promise<Answer> {
  const list = paths(request);
  if (!list) return BAD_REQUEST;
  const sizes: Record<string, { bytes: number | null; partial: boolean }> = {};
  for (const path of list) {
    const result = await run(
      PROGRAMS.du,
      ['--summarize', '--block-size=1', '--one-file-system', '--', path],
      { timeoutMs: LONG_TIMEOUT_MS },
    );
    const bytes = Number(result.stdout.trim().split(/\s+/)[0]);
    sizes[path] = {
      bytes: Number.isFinite(bytes) && result.stdout.trim() ? bytes : null,
      partial: result.code !== 0,
    };
  }
  return ok({ sizes });
}

/**
 * Where a path really is: its folder with symlinks resolved (`rm` follows them up to the last
 * part) — `/var/run/docker.sock` is `/run/docker.sock`. Unchanged when its folder is missing.
 */
function realLocation(path: string): string {
  try {
    return join(realpathSync(dirname(path)), basename(path));
  } catch {
    return path;
  }
}

/** Deletes folders (`rm -r --one-file-system`) — as this account, or by ilex-root for `administrator`. */
export async function removePaths(request: Request): Promise<Answer> {
  const list = paths(request);
  const administrator = request['administrator'];
  if (!list || typeof administrator !== 'boolean') return BAD_REQUEST;
  if (list.some((path) => protectedPath(path) || protectedPath(realLocation(path)))) {
    return refused('path_protected');
  }
  const result = await run(PROGRAMS.rm, ['-r', '-f', '--one-file-system', '--', ...list], {
    timeoutMs: LONG_TIMEOUT_MS,
  });
  if (result.code === 0) return ok();
  if (result.timedOut) return refused('timed_out');
  if (/Permission denied|Operation not permitted/i.test(result.stderr)) {
    return refused('not_permitted');
  }
  return { ok: false, error: 'failed', message: said(result) } as Answer;
}
