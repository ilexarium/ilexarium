import { PROCESS_LIMITS, type Process, processKey } from '@laris/shared';
import { isKernelThread } from '../host/process-parsers.js';
import type { RawProcess } from '../host/host.model.js';
import { STATES, TICKS_PER_SECOND } from './processes.constants.js';
import type { EndRules, ProcessContext } from './processes.model.js';

const isPerson = (uid: number, minUid: number = PROCESS_LIMITS.minUid) =>
  uid >= minUid && uid <= PROCESS_LIMITS.maxUid;

/**
 * Whether a process can be ended here — the app's friendly first check; the process wrapper
 * checks the same again on its own: a person's process (every uid in the people's range, none the
 * app's own), not PID 1, not a kernel thread, not in a container.
 */
export function isEndable(process: RawProcess, rules: EndRules): boolean {
  return (
    process.pid !== 1 &&
    !isKernelThread(process) &&
    process.containerId === null &&
    process.uids.every((uid) => isPerson(uid, rules.minUid)) &&
    !process.uids.includes(rules.appUid)
  );
}

/** One process as the page shows it. */
export function toProcess(raw: RawProcess, context: ProcessContext): Process {
  const kernel = isKernelThread(raw);
  const [uid] = raw.uids;
  const previous = context.previousTicks.get(processKey(raw));
  const cpuPercent =
    previous !== undefined && context.cpuTotalTicks > 0
      ? Math.min(100, Math.max(0, ((raw.cpuTicks - previous) / context.cpuTotalTicks) * 100))
      : 0;
  const memoryPercent =
    context.memoryTotalBytes > 0
      ? Math.min(100, (raw.rssBytes / context.memoryTotalBytes) * 100)
      : 0;
  const container =
    raw.containerId === null
      ? null
      : (context.containers.get(raw.containerId) ?? { name: null, catalogId: null });
  return {
    pid: raw.pid,
    startTicks: raw.startTicks,
    name: raw.name,
    command: raw.command.slice(0, PROCESS_LIMITS.commandMax),
    uid,
    user: context.users.get(uid) ?? null,
    state: STATES[raw.state] ?? 'other',
    cpuPercent,
    memoryBytes: raw.rssBytes,
    memoryPercent,
    startedAt:
      context.bootTime === null
        ? null
        : new Date(
            (context.bootTime + Number(raw.startTicks) / TICKS_PER_SECOND) * 1000,
          ).toISOString(),
    kernel,
    system: kernel || (container === null && !isPerson(uid, context.rules.minUid)),
    container,
    endable: isEndable(raw, context.rules),
  };
}

/**
 * The rules from the process wrapper's config: its `appUid` (this app's user if not set) and
 * `minUid` — so the app's first check and the wrapper's agree.
 */
export function endRules(config: { appUid?: number; minUid?: number } | undefined): EndRules {
  return {
    appUid: config?.appUid ?? process.getuid?.() ?? 0,
    minUid: config?.minUid ?? PROCESS_LIMITS.minUid,
  };
}
