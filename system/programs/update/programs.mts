// Running a program: from its fixed path with an argument list, in an environment built from
// scratch, its output line by line.

import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { readLines } from '../lib/lines.mts';
import { SAFE_PATH } from '../lib/paths.mts';

const LINE_MAX = 16 * 1024;

export interface RunOptions {
  cwd?: string;
  /** A file given to it as stdin (a database dump), or text. */
  stdinFile?: string;
  input?: string;
  timeoutMs?: number;
  onLine?: (line: string) => void;
}

export function runProgram(
  file: string,
  args: string[],
  options: RunOptions = {},
): Promise<number> {
  return new Promise((resolve) => {
    const stdinFd = options.stdinFile ? openSync(options.stdinFile, 'r') : undefined;
    const child = spawn(file, args, {
      env: { PATH: SAFE_PATH, LANG: 'C.UTF-8', HOME: '/root' },
      cwd: options.cwd ?? '/',
      stdio: [stdinFd ?? 'pipe', 'pipe', 'pipe'],
      shell: false,
      timeout: options.timeoutMs,
      killSignal: 'SIGKILL',
    });
    if (stdinFd !== undefined) closeSync(stdinFd);
    else child.stdin!.end(options.input ?? '');
    const onLine = options.onLine ?? (() => {});
    readLines(child.stdout!, LINE_MAX, onLine);
    readLines(child.stderr!, LINE_MAX, onLine);
    child.on('error', () => resolve(127));
    child.on('close', (code) => resolve(code ?? 1));
  });
}
