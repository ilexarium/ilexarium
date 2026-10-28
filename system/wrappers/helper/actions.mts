import { userInfo } from 'node:os';
import {
  KILL_TIMEOUT_MS,
  MESSAGES,
  PASSWORD_MAX,
  PID_MAX,
  PROGRAMS,
  SIGNALS,
  SUDO_TIMEOUT_MS,
} from './config.mts';
import { run, type RunResult } from './run.mts';

export type Answer = { ok: true; [key: string]: unknown } | { ok: false; error: string };

type Request = Record<string, unknown>;

const ok = (fields: Record<string, unknown> = {}): Answer => ({ ok: true, ...fields });
const refused = (error: string): Answer => ({ ok: false, error });
const BAD_REQUEST = refused('bad_request');

/** What a sudo that didn't succeed says; null when it's none of sudo's own refusals. */
function sudoRefusal(result: RunResult): string | null {
  if (result.missing) return 'sudo_unavailable';
  if (MESSAGES.notAllowed.test(result.stderr)) return 'sudo_not_allowed';
  if (MESSAGES.passwordRequired.test(result.stderr)) return 'sudo_required';
  return null;
}

/** One line on sudo's stdin: a line break would end it early, and sudo would read the rest. */
export function acceptablePassword(password: unknown): password is string {
  return (
    typeof password === 'string' &&
    password.length > 0 &&
    password.length <= PASSWORD_MAX &&
    !/[\r\n\0]/.test(password)
  );
}

function hello(): Answer {
  const me = userInfo();
  return ok({ uid: me.uid, user: me.username, home: me.homedir });
}

async function unlockSudo(request: Request): Promise<Answer> {
  const password = request['password'];
  if (!acceptablePassword(password)) return BAD_REQUEST;
  const result = await run(PROGRAMS.sudo, ['-S', '-v'], {
    input: `${password}\n`,
    timeoutMs: SUDO_TIMEOUT_MS,
  });
  if (result.code === 0) return ok();
  if (result.timedOut) return refused('timed_out');
  if (result.missing || MESSAGES.notAllowed.test(result.stderr)) {
    return refused(sudoRefusal(result)!);
  }
  if (MESSAGES.wrongPassword.test(result.stderr)) return refused('wrong_password');
  return refused('failed');
}

async function lockSudo(): Promise<Answer> {
  await run(PROGRAMS.sudo, ['-k'], { timeoutMs: SUDO_TIMEOUT_MS });
  return ok();
}

async function signalProcess(request: Request): Promise<Answer> {
  const { pid, signal, administrator } = request;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 1 || pid > PID_MAX) {
    return BAD_REQUEST;
  }
  if (!SIGNALS.includes(signal as (typeof SIGNALS)[number])) return BAD_REQUEST;
  if (typeof administrator !== 'boolean') return BAD_REQUEST;
  const kill = ['-s', signal as string, '--', String(pid)];
  // -n: never asks; a locked sudo answers sudo_required, and the web app asks for the password.
  const result = administrator
    ? await run(PROGRAMS.sudo, ['-n', '--', PROGRAMS.kill, ...kill], { timeoutMs: KILL_TIMEOUT_MS })
    : await run(PROGRAMS.kill, kill, { timeoutMs: KILL_TIMEOUT_MS });
  if (result.code === 0) return ok();
  if (result.timedOut) return refused('timed_out');
  if (administrator) {
    const refusal = sudoRefusal(result);
    if (refusal) return refused(refusal);
  }
  if (MESSAGES.notFound.test(result.stderr)) return refused('not_found');
  if (MESSAGES.notPermitted.test(result.stderr)) return refused('not_permitted');
  return refused('failed');
}

export function handle(request: Request): Promise<Answer> | Answer {
  switch (request['action']) {
    case 'hello':
      return hello();
    case 'sudo.unlock':
      return unlockSudo(request);
    case 'sudo.lock':
      return lockSudo();
    case 'process.signal':
      return signalProcess(request);
    default:
      return BAD_REQUEST;
  }
}
