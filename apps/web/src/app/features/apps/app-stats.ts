import type { Container, ContainerHistoryPoint } from '@ilex/shared';
import {
  CPU_TREND_MIN_TOP,
  TREND_COLORS,
  TREND_MIN_POINTS,
} from '../containers/containers-table/containers-table.constants';
import { STATS_STEP_MS } from './apps.constants';
import type { AppStats, AppTrends } from './apps.model';

/**
 * An app's CPU and memory now, summed over its containers, and their recent lines. Each
 * container's history is its own (its own sample times; a stopped one keeps its old points), so
 * the lines are summed by time: one step per sample, a container counting as nothing where it
 * has no point — but carried over one step, so a sample that lands just past a step's edge leaves
 * no dip. Null when none of them runs with stats (all stopped, or the first frame not there yet).
 */
export function appStats(
  containers: readonly Container[],
  history: Readonly<Record<string, ContainerHistoryPoint[]>>,
): AppStats | null {
  const running = containers.filter((c) => c.state === 'running' && c.stats);
  if (running.length === 0) return null;
  const byStep = running.map((c) => {
    const steps = new Map<number, ContainerHistoryPoint>();
    for (const point of history[c.id] ?? []) steps.set(Math.floor(point.at / STATS_STEP_MS), point);
    return steps;
  });
  const steps = [...new Set(byStep.flatMap((s) => [...s.keys()]))].sort((a, b) => a - b);
  const cpuHistory: number[] = [];
  const memoryHistory: number[] = [];
  for (const step of steps) {
    let cpu = 0;
    let memory = 0;
    for (const points of byStep) {
      const point = points.get(step) ?? points.get(step - 1);
      cpu += point?.cpuPercent ?? 0;
      memory += point?.memoryUsedBytes ?? 0;
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
