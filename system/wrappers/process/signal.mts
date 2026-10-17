// process/signal.mts — REVIEW-REQUIRED (system/CLAUDE.md): runs as root.
//
// Checking the request and the process, then sending the signal — as the process's owner.

import type { Config, ProcessInfo, SignalRequest } from './model.mts';
import { MAX_UID, minUid, procRoot } from './config.mts';
import { PF_KTHREAD, readProcess } from './proc.mts';
import { parseInput } from '../lib/input.mts';
import { Refusal } from '../lib/output.mts';
import { isRoot } from '../lib/startup.mts';

/**
 * The group it signals with: `nogroup`, no rights of its own. The kernel decides whether a signal
 * may be sent by uid alone, so the process's own group (possibly root's) is never taken on.
 */
const NOGROUP = 65534;

/** Linux's highest PID (`pid_max` at most 2^22). */
const MAX_PID = 4_194_304;

export function parseRequest(input: string): SignalRequest {
  const value = parseInput(input, ['pid', 'startTicks', 'signal']);
  const { pid, startTicks, signal } = value;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 1 || pid > MAX_PID) {
    throw new Refusal('invalid_request', 'pid: not a process ID', 2, 'pid');
  }
  if (typeof startTicks !== 'string' || !/^\d{1,20}$/.test(startTicks)) {
    throw new Refusal('invalid_request', 'startTicks: not a start time', 2, 'startTicks');
  }
  if (signal !== 'TERM' && signal !== 'KILL') {
    throw new Refusal('invalid_request', 'signal: TERM or KILL', 2, 'signal');
  }
  return { pid, startTicks, signal };
}

/** Why this process may not be signalled here, or null if it may. */
export function refusal(config: Config, info: ProcessInfo): string | null {
  if ((info.flags & PF_KTHREAD) !== 0) return 'a kernel thread';
  if (info.inContainer) return 'in a container';
  const appUid = config.process.appUid;
  if (info.uids.some((uid) => uid < minUid(config) || uid > MAX_UID)) {
    return 'not a person’s process';
  }
  if (appUid !== undefined && info.uids.includes(appUid)) return 'the app’s own process';
  return null;
}

/** The same process still (PID and start time), or a refusal. */
function current(proc: string, request: SignalRequest): ProcessInfo {
  const info = readProcess(proc, request.pid);
  if (!info || info.startTicks !== request.startTicks) {
    throw new Refusal('process_not_found', 'no such process (ended, or the PID is used again)');
  }
  return info;
}

/**
 * Sends the signal, as the owner: in root mode this program first takes on the owner's real uid,
 * with no groups but `nogroup` — from then on the kernel lets it signal only that person's
 * processes. In development (not root) it runs as the developer anyway.
 */
export function sendSignal(config: Config, input: string): void {
  const request = parseRequest(input);
  if (request.pid === 1 || request.pid === process.pid || request.pid === process.ppid) {
    throw new Refusal('process_protected', 'never this process');
  }
  const proc = procRoot(config);
  const info = current(proc, request);
  const refused = refusal(config, info);
  if (refused) throw new Refusal('process_protected', refused);

  if (isRoot) {
    const [owner] = info.uids;
    // POSIX only: without them this program can't act as the owner, so it doesn't act at all.
    if (!process.setgroups || !process.setgid || !process.setuid) {
      throw new Refusal('setup', 'can’t take on another identity here', 6);
    }
    process.setgroups([]);
    process.setgid(NOGROUP);
    process.setuid(owner);
    if (
      process.getuid?.() !== owner ||
      process.geteuid?.() !== owner ||
      process.getgid?.() !== NOGROUP ||
      process.getegid?.() !== NOGROUP ||
      (process.getgroups?.() ?? []).some((group) => group !== NOGROUP)
    ) {
      throw new Refusal('setup', 'could not take on the owner’s identity', 6);
    }
  }
  // Read again, as the owner: still the same process, still allowed.
  const again = current(proc, request);
  const stillRefused = refusal(config, again);
  if (stillRefused) throw new Refusal('process_protected', stillRefused);

  try {
    process.kill(request.pid, `SIG${request.signal}`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') throw new Refusal('process_not_found', 'it ended meanwhile');
    if (code === 'EPERM') throw new Refusal('process_protected', 'the kernel refused the signal');
    throw new Refusal('signal_failed', `the signal failed: ${code ?? 'unknown'}`, 5);
  }
}
