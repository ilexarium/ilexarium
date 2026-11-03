import { spawn } from 'node:child_process';
import { userInfo } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { OUTPUT_MAX, PATH } from './config.mts';
import { readLines } from '../lib/lines.mts';

export interface RunResult {
  /** Its exit code; null when it ended by a signal, didn't start or didn't finish. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** It couldn't be started (not installed). */
  missing: boolean;
  timedOut: boolean;
}

const me = userInfo();

/** Built from scratch: nothing of the SSH session's environment reaches a program. */
export const ENVIRONMENT = {
  PATH,
  HOME: me.homedir,
  USER: me.username,
  LOGNAME: me.username,
  LANG: 'C',
  LC_ALL: 'C',
  // `systemctl --user` and `systemd-run --user` find the account's own systemd here.
  XDG_RUNTIME_DIR: `/run/user/${me.uid}`,
  DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${me.uid}/bus`,
};

/**
 * Runs a program (no shell), `input` on its stdin; of its output the last `outputMax` characters
 * are kept, from a line start — the end is what matters (the root programs' result markers).
 */
export function run(
  program: string,
  args: string[],
  options: { input?: string; timeoutMs: number; cwd?: string; outputMax?: number },
): Promise<RunResult> {
  const max = options.outputMax ?? OUTPUT_MAX;
  return new Promise((resolve) => {
    let finished = false;
    const done = (result: RunResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(result);
    };
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const keep = (text: string, piece: string) => {
      const all = text + piece;
      if (all.length <= max) return all;
      const cut = all.slice(all.length - max);
      const lineStart = cut.indexOf('\n');
      return lineStart >= 0 ? cut.slice(lineStart + 1) : cut;
    };
    // A character split between two chunks is decoded whole.
    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');
    const child = spawn(program, args, {
      env: ENVIRONMENT,
      cwd: options.cwd ?? me.homedir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => (stdout = keep(stdout, outDecoder.write(chunk))));
    child.stderr.on('data', (chunk: Buffer) => (stderr = keep(stderr, errDecoder.write(chunk))));
    child.on('error', () => {
      done({ code: null, stdout, stderr, missing: true, timedOut: false });
    });
    child.on('close', (code) => {
      done({ code: timedOut ? null : code, stdout, stderr, missing: false, timedOut });
    });
    // A program that exits without reading its input closes the pipe first (EPIPE).
    child.stdin.on('error', () => {});
    child.stdin.end(options.input ?? '');
  });
}

/**
 * Runs a program (no shell) and hands each line of its output to `onLine`, which answers false
 * to stop it there — what's long is never held whole. A line over `lineMax` is skipped.
 */
export function runLines(
  program: string,
  args: string[],
  options: { timeoutMs: number; lineMax: number },
  onLine: (line: string) => boolean,
): Promise<{ code: number | null; stopped: boolean; missing: boolean; timedOut: boolean }> {
  return new Promise((resolve) => {
    let stopped = false;
    let timedOut = false;
    let missing = false;
    const child = spawn(program, args, {
      env: ENVIRONMENT,
      cwd: me.homedir,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);
    readLines(child.stdout, options.lineMax, (line) => {
      if (stopped || timedOut) return;
      if (!onLine(line)) {
        stopped = true;
        child.kill('SIGKILL');
      }
    });
    let finished = false;
    const done = (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ code: stopped || timedOut ? null : code, stopped, missing, timedOut });
    };
    child.on('error', () => {
      missing = true;
      done(null);
    });
    child.on('close', done);
  });
}
