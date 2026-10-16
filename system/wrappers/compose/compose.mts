// compose/compose.mts — REVIEW-REQUIRED (system/CLAUDE.md): runs as root.
//
// Running Compose — one fixed way, a clean environment — and the lock.

import { type ChildProcess, spawn } from 'node:child_process';
import { dirname } from 'node:path';
import type { Config } from './config.mts';
import { tryLock } from '../lib/lock.mts';
import { Refusal, relay } from '../lib/output.mts';
import { SAFE_PATH } from '../lib/paths.mts';
import { isRoot } from '../lib/startup.mts';

export let current: ChildProcess | null = null;

export function compose(
  config: Config,
  project: string,
  composeFile: string | null,
  args: string[],
  env: Record<string, string>,
  capture = false,
): Promise<{ code: number; stdout: string }> {
  const fileArgs = composeFile
    ? ['-f', composeFile, '--project-directory', dirname(composeFile)]
    : [];
  const fullArgs = ['compose', '--progress', 'plain', '-p', project, ...fileArgs, ...args];
  const home = isRoot ? '/root' : (config.home ?? '/tmp');
  return new Promise((resolve, reject) => {
    const child = spawn(config.dockerBin, fullArgs, {
      // Built from scratch: nothing from this program's own environment reaches Compose.
      env: { PATH: SAFE_PATH, HOME: home, ...env },
      // Never the caller's folder: without -f (down), Compose would load a compose.yml found
      // there — one the app could have planted. `/` is root's, and has no compose file.
      cwd: '/',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    current = child;
    let stdout = '';
    if (capture) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
        if (stdout.length > 4 * 1024 * 1024) child.kill('SIGTERM');
      });
    } else {
      relay(child.stdout);
    }
    relay(child.stderr);
    child.on('error', reject);
    child.on('close', (code) => {
      current = null;
      resolve({ code: code ?? 1, stdout });
    });
  });
}

/** One operation at a time: the lock is shared with the backup wrapper (lib/lock.mts). */
export function takeLock(path: string): () => void {
  const release = tryLock(path);
  if (!release) throw new Refusal('busy', 'another install or removal is running', 3);
  return release;
}
