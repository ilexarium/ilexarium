import { spawn } from 'node:child_process';
import { userInfo } from 'node:os';
import { OUTPUT_MAX, PATH } from './config.mts';

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
const ENVIRONMENT = {
  PATH,
  HOME: me.homedir,
  USER: me.username,
  LOGNAME: me.username,
  LANG: 'C',
  LC_ALL: 'C',
};

/** Runs a program (no shell), `input` on its stdin; output kept up to `OUTPUT_MAX`. */
export function run(
  program: string,
  args: string[],
  options: { input?: string; timeoutMs: number },
): Promise<RunResult> {
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
    const keep = (text: string, chunk: Buffer) =>
      text.length < OUTPUT_MAX ? (text + chunk.toString('utf8')).slice(0, OUTPUT_MAX) : text;
    const child = spawn(program, args, {
      env: ENVIRONMENT,
      cwd: me.homedir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => (stdout = keep(stdout, chunk)));
    child.stderr.on('data', (chunk: Buffer) => (stderr = keep(stderr, chunk)));
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
