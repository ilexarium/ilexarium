import { existsSync } from 'node:fs';
import { MESSAGES, PATH_FORBIDDEN, PATH_MAX, PROGRAMS } from './config.mts';
import { run, type RunResult } from './run.mts';

export type Answer = { ok: true; [key: string]: unknown } | { ok: false; error: string };

export type Request = Record<string, unknown>;

export const ok = (fields: Record<string, unknown> = {}): Answer => ({ ok: true, ...fields });
export const refused = (error: string): Answer => ({ ok: false, error });
export const BAD_REQUEST = refused('bad_request');

/** What a sudo that didn't succeed says; null when it's none of sudo's own refusals. */
export function sudoRefusal(result: RunResult): string | null {
  if (result.missing) return 'sudo_unavailable';
  if (MESSAGES.notAllowed.test(result.stderr)) return 'sudo_not_allowed';
  if (MESSAGES.passwordRequired.test(result.stderr)) return 'sudo_required';
  return null;
}

/** Runs a program as this account, or as root through sudo -n (never asking: a locked sudo answers sudo_required). */
export function runAs(
  administrator: boolean,
  program: string,
  args: string[],
  options: Parameters<typeof run>[2],
): Promise<RunResult> {
  if (!administrator) return run(program, args, options);
  // Through sudo, a missing program would be sudo's "command not found", read as its refusal.
  if (!existsSync(program)) {
    return Promise.resolve({ code: null, stdout: '', stderr: '', missing: true, timedOut: false });
  }
  return run(PROGRAMS.sudo, ['-n', '--', program, ...args], options);
}

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
