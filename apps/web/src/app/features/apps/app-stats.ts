import type { Container, ContainerHistoryPoint } from '@laris/shared';
import {
  CPU_TREND_MIN_TOP,
  TREND_COLORS,
  TREND_MIN_POINTS,
} from '../containers/containers-table/containers-table.constants';
import type { AppStats, AppTrends } from './apps.model';

/**
 * An app's CPU and memory now, summed over its containers, and their recent lines. The histories
 * are summed from their newest point back (each sample adds one point per running container); a
 * container that started later counts as nothing before its first point. Null when none of them
 * has stats (all stopped, or the first frame not there yet).
 */
export function appStats(
  containers: readonly Container[],
  history: Readonly<Record<string, ContainerHistoryPoint[]>>,
): AppStats | null {
  const running = containers.filter((c) => c.state === 'running' && c.stats);
  if (running.length === 0) return null;
  const histories = running.map((c) => history[c.id] ?? []);
  const length = Math.max(...histories.map((h) => h.length));
  const cpuHistory: number[] = [];
  const memoryHistory: number[] = [];
  for (let back = length; back > 0; back--) {
    let cpu = 0;
    let memory = 0;
    for (const points of histories) {
      const point = points[points.length - back];
      if (!point) continue;
      cpu += point.cpuPercent;
      memory += point.memoryUsedBytes;
    }
    cpuHistory.push(cpu);
    memoryHistory.push(memory);
  }
  return {
    cpuPercent: running.reduce((sum, c) => sum + c.stats!.cpuPercent, 0),
    memoryUsedBytes: running.reduce((sum, c) => sum + c.stats!.memoryUsedBytes, 0),
    cpuHistory,
    memoryHistory,
  };
}

/** The lines as the Containers page draws them; none below two points. */
export function appTrends(stats: AppStats | null): AppTrends {
  if (!stats || stats.cpuHistory.length < TREND_MIN_POINTS) return { cpu: null, memory: null };
  return {
    // A floor for the top, so an idle app's few tenths of a percent stay a flat line.
    cpu: {
      series: [{ values: stats.cpuHistory, color: TREND_COLORS.cpu }],
      max: Math.max(CPU_TREND_MIN_TOP, ...stats.cpuHistory),
    },
    memory: [{ values: stats.memoryHistory, color: TREND_COLORS.memory }],
  };
}

/** The folder as the person reads it: `~/apps/notes` for one in its owner's home. */
export function shortFolder(folder: string, owner: string | null): string {
  const home = owner ? `/home/${owner}` : null;
  if (home && (folder === home || folder.startsWith(`${home}/`))) {
    return `~${folder.slice(home.length)}`;
  }
  return folder;
}
