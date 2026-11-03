import { userInfo } from 'node:os';
import { BAD_REQUEST, ok, refused, type Answer, type Request } from './answers.mts';
import { checkCompose, dockerAccess, removeVolumes, startTask, taskState } from './apps.mts';
import { KILL_TIMEOUT_MS, MESSAGES, PID_MAX, PROGRAMS, SIGNALS } from './config.mts';
import { listBoots, readJournal } from './journal.mts';
import { pathSizes, removePaths } from './paths.mts';
import { run } from './run.mts';
import { forward, unlock } from './sudo.mts';
import { listUnits, showUnit } from './units.mts';

export type { Answer, Request } from './answers.mts';

function hello(): Answer {
  const me = userInfo();
  return ok({ uid: me.uid, gid: me.gid, user: me.username, home: me.homedir });
}

/** Ends a process — run by whoever is asked: this account, or laris-root for `administrator`. */
export async function signalProcess(request: Request): Promise<Answer> {
  const { pid, signal, administrator } = request;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 1 || pid > PID_MAX) {
    return BAD_REQUEST;
  }
  if (!SIGNALS.includes(signal as (typeof SIGNALS)[number])) return BAD_REQUEST;
  if (typeof administrator !== 'boolean') return BAD_REQUEST;
  const result = await run(PROGRAMS.kill, ['-s', signal as string, '--', String(pid)], {
    timeoutMs: KILL_TIMEOUT_MS,
  });
  if (result.code === 0) return ok();
  if (result.timedOut) return refused('timed_out');
  if (MESSAGES.notFound.test(result.stderr)) return refused('not_found');
  if (MESSAGES.notPermitted.test(result.stderr)) return refused('not_permitted');
  return refused('failed');
}

/** What laris-root does for this account (docs/plans/laris_root.md): forwarded to it. */
export function privileged(request: Request): boolean {
  switch (request['action']) {
    case 'process.signal':
    case 'paths.remove':
    case 'journal.read':
    case 'journal.boots':
      return request['administrator'] === true;
    case 'volumes.remove':
      return request['docker'] === 'sudo';
    case 'root.run':
    case 'units.control':
      return true;
    default:
      return false;
  }
}

export function handle(request: Request): Promise<Answer> | Answer {
  if (privileged(request)) return forward(request);
  switch (request['action']) {
    case 'hello':
      return hello();
    case 'sudo.unlock':
      return unlock(request);
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
    case 'volumes.remove':
      return removeVolumes(request);
    case 'paths.size':
      return pathSizes(request);
    case 'paths.remove':
      return removePaths(request);
    case 'units.list':
      return listUnits();
    case 'units.show':
      return showUnit(request);
    case 'journal.read':
      return readJournal(request);
    case 'journal.boots':
      return listBoots(request);
    default:
      return BAD_REQUEST;
  }
}
