// The root programs (laris-backup, laris-disk) through this account's sudo — never asking: a
// locked sudo answers sudo_required. Their input goes on stdin; their output (markers and
// results) comes back as it is, for the server to read.

import { BAD_REQUEST, ok, refused, sudoRefusal, type Answer, type Request } from './answers.mts';
import {
  PROGRAMS,
  ROOT_OUTPUT_MAX,
  ROOT_PROGRAMS,
  ROOT_TIMEOUT_MAX_MS,
  QUICK_TIMEOUT_MS,
} from './config.mts';
import { run } from './run.mts';

export async function runRoot(request: Request): Promise<Answer> {
  const { program, command: action, input, timeoutMs } = request;
  const known = typeof program === 'string' && Object.hasOwn(ROOT_PROGRAMS, program);
  if (!known || typeof action !== 'string') return BAD_REQUEST;
  const { path, actions } = ROOT_PROGRAMS[program];
  if (!actions.includes(action)) return BAD_REQUEST;
  if (typeof input !== 'string') return BAD_REQUEST;
  const timeout =
    timeoutMs === undefined
      ? QUICK_TIMEOUT_MS
      : typeof timeoutMs === 'number' && timeoutMs > 0 && timeoutMs <= ROOT_TIMEOUT_MAX_MS
        ? timeoutMs
        : null;
  if (timeout === null) return BAD_REQUEST;
  const result = await run(PROGRAMS.sudo, ['-n', '--', path, action], {
    input,
    timeoutMs: timeout,
    outputMax: ROOT_OUTPUT_MAX,
  });
  if (result.timedOut) return refused('timed_out');
  // The program's own markers (@@…) say it ran: then sudo didn't refuse.
  if (!result.stdout.includes('@@')) {
    const refusal = sudoRefusal(result);
    if (refusal) return refused(refusal);
  }
  return ok({ code: result.code, output: result.stdout });
}
