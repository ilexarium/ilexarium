// Root through this account's own sudo (docs/plans/laris_root.md): unlocking starts laris-root
// with `sudo -k -S`, the password the one line sudo reads; it runs until it's idle for 15 minutes
// or this helper ends (its stdin closes) — "Lock now" is a new helper. Unlocked means it runs.
// Every privileged action is forwarded to it; while it isn't running, they answer sudo_required.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { BAD_REQUEST, ok, refused, type Answer, type Request } from './answers.mts';
import {
  FAKE_BIN,
  MESSAGES,
  PASSWORD_MAX,
  PROGRAMS,
  ROOT_ANSWER_MAX,
  SUDO_TIMEOUT_MS,
} from './config.mts';
import { ENVIRONMENT } from './run.mts';

interface Root {
  child: ChildProcessWithoutNullStreams;
  waiting: Map<number, (answer: Answer) => void>;
  nextId: number;
}

let root: Root | null = null;

const testSettings = () =>
  Object.fromEntries(
    ['LARIS_HELPER_FAKE_BIN', 'LARIS_ROOT_IDLE_MS'].flatMap((name) =>
      process.env[name] ? [[name, process.env[name]]] : [],
    ),
  );

/** One line on sudo's stdin: a line break would end it early, and sudo would read the rest. */
export function acceptablePassword(password: unknown): password is string {
  return (
    typeof password === 'string' &&
    password.length > 0 &&
    password.length <= PASSWORD_MAX &&
    !/[\r\n\0]/.test(password)
  );
}

/** Tells the server that root ended on its own (idle, or it failed). */
function locked(): void {
  process.stdout.write(`${JSON.stringify({ event: 'sudo.locked' })}\n`);
}

/** Reads its lines: the ready line first, then answers by id. */
function lines(child: ChildProcessWithoutNullStreams, onLine: (line: string) => void): void {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += decoder.write(chunk);
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      onLine(line);
    }
    if (buffer.length > ROOT_ANSWER_MAX) {
      buffer = '';
      child.stdin.end();
    }
  });
}

function answered(started: Root, line: string): void {
  let parsed: { id?: unknown } & Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as typeof parsed;
  } catch {
    return;
  }
  const resolve = typeof parsed.id === 'number' ? started.waiting.get(parsed.id) : undefined;
  if (!resolve) return;
  started.waiting.delete(parsed.id as number);
  const { id: _, ...answer } = parsed;
  resolve(answer as Answer);
}

/** Waits for laris-root's ready line, or what sudo says instead; sudo gets no second try. */
function ready(started: Root, password: string): Promise<Answer> {
  const { child } = started;
  return new Promise((resolve) => {
    let settled = false;
    let stderr = '';
    const settle = (answer: Answer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A wrong password: sudo would read the next line as another try.
      if (!answer.ok) child.stdin.end();
      resolve(answer);
    };
    const timer = setTimeout(() => settle(refused('timed_out')), SUDO_TIMEOUT_MS);
    const said = () => {
      if (MESSAGES.notAllowed.test(stderr)) return 'sudo_not_allowed';
      if (MESSAGES.wrongPassword.test(stderr)) return 'wrong_password';
      return null;
    };
    child.on('error', () => settle(refused('sudo_unavailable')));
    child.stdin.on('error', () => {});
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (settled) return;
      stderr = (stderr + chunk).slice(-4096);
      const refusal = said();
      if (refusal) settle(refused(refusal));
    });
    child.on('close', () => settle(refused(said() ?? 'failed')));
    let first = true;
    lines(child, (line) => {
      if (!first) {
        answered(started, line);
        return;
      }
      first = false;
      let hello: Record<string, unknown> | null = null;
      try {
        hello = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // not laris-root speaking
      }
      settle(hello?.['laris-root'] === 1 && !hello['error'] ? ok() : refused('failed'));
    });
    child.stdin.write(`${password}\n`);
  });
}

export async function unlock(request: Request): Promise<Answer> {
  const password = request['password'];
  if (!acceptablePassword(password)) return BAD_REQUEST;
  // Already unlocked: its idle time starts again.
  if (root) return forward({ action: 'touch' });
  // -k: sudo's own cache (tied to this process, without a terminal) is never used — sudo always
  // reads the password and checks it, and never takes it for a request to laris-root.
  const child = spawn(PROGRAMS.sudo, ['-k', '-S', '-p', '', '--', PROGRAMS.root], {
    // Tests: their fake programs reach laris-root (the real sudo resets the environment anyway).
    env: FAKE_BIN ? { ...ENVIRONMENT, ...testSettings() } : ENVIRONMENT,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const started: Root = { child, waiting: new Map(), nextId: 0 };
  const result = await ready(started, password);
  if (!result.ok) return result;
  child.on('close', (code) => {
    // It ends on its own (idle, or its stdin closed) only with nothing running: what still waits
    // was never taken, and asks for the password again. Otherwise it failed during the request.
    const answer = refused(code === 0 ? 'sudo_required' : 'failed');
    for (const resolve of started.waiting.values()) resolve(answer);
    started.waiting.clear();
    if (root === started) {
      root = null;
      locked();
    }
  });
  // Unlocked twice at once (both started while it wasn't running): the earlier one ends.
  (root as Root | null)?.child.stdin.end();
  root = started;
  return ok();
}

/** The helper ends: laris-root's stdin closes, and it ends once what it's doing is done. */
export function endRoot(): void {
  const current = root;
  root = null;
  current?.child.stdin.end();
}

/** A privileged request, done by laris-root; sudo_required while it isn't running. */
export function forward(request: Request): Promise<Answer> {
  const current = root;
  if (!current) return Promise.resolve(refused('sudo_required'));
  const id = ++current.nextId;
  return new Promise((resolve) => {
    current.waiting.set(id, resolve);
    current.child.stdin.write(`${JSON.stringify({ ...request, id })}\n`);
  });
}
