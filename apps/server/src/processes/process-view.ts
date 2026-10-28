import { PROCESS_LIMITS, type Process, processKey } from '@laris/shared';
import { isKernelThread } from '../host/process-parsers.js';
import type { RawProcess } from '../host/host.model.js';
import { STATES, TICKS_PER_SECOND } from './processes.constants.js';
import type { ProcessContext } from './processes.model.js';

const isPerson = (uid: number) => uid >= PROCESS_LIMITS.minUid && uid <= PROCESS_LIMITS.maxUid;

/** One process as the page shows it. */
export function toProcess(raw: RawProcess, context: ProcessContext): Process {
  const kernel = isKernelThread(raw);
  const [uid] = raw.uids;
  const previous = context.previousTicks.get(processKey(raw));
  // The machine's ticks count every core: a share of them times the cores is per core, as htop.
  const cpuPercent =
    previous !== undefined && context.cpuTotalTicks > 0
      ? Math.min(
          100 * context.cores,
          Math.max(0, ((raw.cpuTicks - previous) / context.cpuTotalTicks) * 100 * context.cores),
        )
      : 0;
  const memoryPercent =
    context.memoryTotalBytes > 0
      ? Math.min(100, (raw.rssBytes / context.memoryTotalBytes) * 100)
      : 0;
  const container =
    raw.containerId === null
      ? null
      : (context.containers.get(raw.containerId) ?? { name: null, app: null });
  return {
    pid: raw.pid,
    startTicks: raw.startTicks,
    name: raw.name,
    command: raw.command.slice(0, PROCESS_LIMITS.commandMax),
    uid,
    user: context.users.get(uid) ?? null,
    state: STATES[raw.state] ?? 'other',
    cpuPercent,
    cpuSeconds: raw.cpuTicks / TICKS_PER_SECOND,
    priority: raw.priority,
    nice: raw.nice,
    memoryBytes: raw.rssBytes,
    virtualBytes: raw.virtualBytes,
    sharedBytes: raw.sharedBytes,
    memoryPercent,
    startedAt:
      context.bootTime === null
        ? null
        : new Date(
            (context.bootTime + Number(raw.startTicks) / TICKS_PER_SECOND) * 1000,
          ).toISOString(),
    kernel,
    system: kernel || (container === null && !isPerson(uid)),
    container,
  };
}
