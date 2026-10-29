import { PATH_FORBIDDEN, PATH_MAX } from './config.mts';
import type { RunResult } from './run.mts';

export type Answer = { ok: true; [key: string]: unknown } | { ok: false; error: string };

export type Request = Record<string, unknown>;

export const ok = (fields: Record<string, unknown> = {}): Answer => ({ ok: true, ...fields });
export const refused = (error: string): Answer => ({ ok: false, error });
export const BAD_REQUEST = refused('bad_request');

/** An absolute path in its plain form: no empty, "." or ".." parts, one line. */
export function plainPath(path: unknown): path is string {
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > PATH_MAX) return false;
  if (PATH_FORBIDDEN.test(path)) return false;
  if (path === '/') return true;
  return path
    .slice(1)
    .split('/')
    .every((part) => part !== '' && part !== '.' && part !== '..');
}

export const inside = (path: string, root: string) =>
  path === root || path.startsWith(root === '/' ? '/' : `${root}/`);

/** The first lines of what a program said, for the person to read. */
export const said = (result: RunResult) =>
  (result.stderr || result.stdout).trim().split('\n').slice(-20).join('\n');
