import { userInfo } from 'node:os';
import {
  BAD_REQUEST,
  ok,
  refused,
  runAs,
  sudoRefusal,
  type Answer,
  type Request,
} from './answers.mts';
import {
  checkCompose,
  composeImages,
  dockerAccess,
  removeVolumes,
  startTask,
  taskState,
} from './apps.mts';
import {
  KILL_TIMEOUT_MS,
  MESSAGES,
  PASSWORD_MAX,
  PID_MAX,
  PROGRAMS,
  SIGNALS,
  SUDO_TIMEOUT_MS,
} from './config.mts';
import { pathSizes, removePaths } from './paths.mts';
import { runRoot } from './root.mts';
import { run } from './run.mts';

export type { Answer } from './answers.mts';

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
  return ok({ uid: me.uid, gid: me.gid, user: me.username, home: me.homedir });
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
  const result = await runAs(administrator, PROGRAMS.kill, kill, { timeoutMs: KILL_TIMEOUT_MS });
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
    case 'docker.access':
      return dockerAccess();
    case 'app.task':
      return startTask(request);
    case 'app.taskState':
      return taskState(request);
    case 'compose.check':
      return checkCompose(request);
    case 'compose.images':
      return composeImages(request);
    case 'volumes.remove':
      return removeVolumes(request);
    case 'paths.size':
      return pathSizes(request);
    case 'paths.remove':
      return removePaths(request);
    case 'root.run':
      return runRoot(request);
    default:
      return BAD_REQUEST;
  }
}
