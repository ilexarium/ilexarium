// backup/programs.mts — REVIEW-REQUIRED (system/CLAUDE.md): runs as root.
//
// Running Borg and Docker — one fixed way each, a clean environment — and the lock.

import { type ChildProcess, spawn } from 'node:child_process';
import { join } from 'node:path';
import { LOCK_POLL_MS } from './config.mts';
import type { BorgLog, Config, Paths, Ran } from './model.mts';
import { tryLock } from '../lib/lock.mts';
import { Refusal, emit } from '../lib/output.mts';
import { SAFE_PATH } from '../lib/paths.mts';
import { isRoot } from '../lib/startup.mts';

export const CAT = '/usr/bin/cat';

export let current: ChildProcess | null = null;

export let stopping = false;

/** A stop (SIGTERM, SIGINT): the running program is told to end; each step then cleans up. */
export function stopRunning(): void {
  stopping = true;
  current?.kill('SIGTERM');
}

export function home(config: Config): string {
  return isRoot ? '/root' : (config.home ?? '/tmp');
}

export function borgEnv(config: Config, paths: Paths): Record<string, string> {
  return {
    PATH: SAFE_PATH,
    HOME: home(config),
    LANG: 'C.UTF-8',
    // Its cache, security records and lock: root-only, under the state folder.
    BORG_BASE_DIR: join(paths.state, 'borg'),
    // The passphrase from its root-only file: never in arguments, the environment or output.
    BORG_PASSCOMMAND: `${CAT} ${paths.passphrase}`,
    BORG_DISPLAY_PASSPHRASE: 'no',
    // Many items, one archive each: don't let the files cache forget unchanged files too soon.
    BORG_FILES_CACHE_TTL: '100',
    BORG_RELOCATED_REPO_ACCESS_IS_OK: 'no',
    BORG_UNKNOWN_UNENCRYPTED_REPO_ACCESS_IS_OK: 'no',
    BORG_CHECK_I_KNOW_WHAT_I_AM_DOING: 'NO',
    BORG_DELETE_I_KNOW_WHAT_I_AM_DOING: 'NO',
  };
}

/**
 * Runs a program (no shell). Its stdout is captured (`capture`), written to a file (`stdoutFd`) or
 * relayed; its stderr is relayed line by line — Borg's JSON log lines (`--log-json`) as their
 * message — each prefixed "> ".
 */
export function runProgram(
  file: string,
  args: string[],
  options: {
    env: Record<string, string>;
    cwd?: string;
    capture?: boolean;
    stdoutFd?: number;
    onLine?: (line: string) => void;
  },
): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      env: options.env,
      cwd: options.cwd ?? '/',
      stdio: ['ignore', options.stdoutFd ?? 'pipe', 'pipe'],
      shell: false,
    });
    current = child;
    let stdout = '';
    const logs: BorgLog[] = [];
    const line = (text: string) => {
      emit(`> ${text}`);
      options.onLine?.(text);
    };
    const lines = (stream: NodeJS.ReadableStream, each: (l: string) => void) => {
      let rest = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        const parts = (rest + chunk).split(/\r?\n/);
        rest = parts.pop() ?? '';
        parts.forEach(each);
      });
      stream.on('end', () => rest && each(rest));
    };
    if (child.stdout) {
      if (options.capture) {
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          stdout += chunk;
          if (stdout.length > 16 * 1024 * 1024) child.kill('SIGTERM');
        });
      } else {
        lines(child.stdout, line);
      }
    }
    lines(child.stderr!, (text) => {
      if (text.startsWith('{')) {
        try {
          const log = JSON.parse(text) as Record<string, unknown>;
          if (log['type'] === 'log_message') {
            const entry = {
              level: String(log['levelname'] ?? ''),
              message: String(log['message'] ?? ''),
              msgid: String(log['msgid'] ?? ''),
            };
            logs.push(entry);
            line(entry.message);
            return;
          }
          return; // progress and other JSON lines: not output
        } catch {
          // not JSON after all
        }
      }
      line(text);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      current = null;
      resolve({ code: code ?? 1, stdout, logs });
    });
  });
}

export function borg(
  config: Config,
  paths: Paths,
  command: string,
  args: string[],
  options: { cwd?: string; capture?: boolean; onLine?: (line: string) => void } = {},
): Promise<Ran> {
  return runProgram(config.backup.borgBin, [command, '--log-json', ...args], {
    env: borgEnv(config, paths),
    ...options,
  });
}

export function docker(
  config: Config,
  args: string[],
  options: { capture?: boolean; stdoutFd?: number; onLine?: (line: string) => void } = {},
): Promise<Ran> {
  return runProgram(config.dockerBin, args, {
    env: { PATH: SAFE_PATH, HOME: home(config) },
    ...options,
  });
}

/** What a failed Borg call means, from its log messages. */
export function borgFailure(logs: BorgLog[], fallback = 'borg_failed'): string {
  const ids = new Set(logs.map((l) => l.msgid));
  if (ids.has('PassphraseWrong')) return 'passphrase_invalid';
  if (
    ids.has('Repository.DoesNotExist') ||
    ids.has('Repository.InvalidRepository') ||
    ids.has('Repository.ParentPathDoesNotExist')
  ) {
    return 'repository_mismatch';
  }
  if (logs.some((l) => /No space left on device|\[Errno 28\]/.test(l.message))) return 'disk_full';
  return fallback;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function takeLock(paths: Paths, wait: boolean): Promise<() => void> {
  const deadline = Date.now() + (wait ? paths.lockWaitMs : 0);
  for (;;) {
    const release = tryLock(paths.lock);
    if (release) return release;
    if (Date.now() >= deadline || stopping) {
      throw new Refusal('busy', 'another operation is running', 3);
    }
    await sleep(Math.min(isRoot ? LOCK_POLL_MS : 50, Math.max(deadline - Date.now(), 1)));
  }
}
