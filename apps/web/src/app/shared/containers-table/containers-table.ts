import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, input } from '@angular/core';
import type {
  Container,
  ContainerHealth,
  ContainersSnapshot,
  ContainerState,
} from '@homelab/shared';
import { HlmBadgeImports } from '@ui/badge';
import { HlmCardImports } from '@ui/card';
import { HlmSkeleton } from '@ui/skeleton';
import { HlmTableImports } from '@ui/table';
import { formatBytes, formatDuration, formatPercent } from '../format/format';
import { ContainerActions } from './container-actions';

const STATE_LABELS: Record<ContainerState, string> = {
  running: 'Running',
  created: 'Created',
  restarting: 'Restarting',
  paused: 'Paused',
  removing: 'Removing',
  exited: 'Stopped',
  dead: 'Dead',
};

const STATE_DOTS: Record<ContainerState, string> = {
  running: 'bg-emerald-500',
  created: 'bg-muted-foreground',
  restarting: 'bg-amber-500',
  paused: 'bg-amber-500',
  removing: 'bg-muted-foreground',
  exited: 'bg-muted-foreground',
  dead: 'bg-destructive',
};

const HEALTH_LABELS: Record<Exclude<ContainerHealth, 'none'>, string> = {
  healthy: 'Healthy',
  unhealthy: 'Unhealthy',
  starting: 'Starting',
};

interface Row {
  id: string;
  name: string;
  image: string;
  stateLabel: string;
  stateDot: string;
  health: { label: string; problem: boolean } | null;
  cpu: string;
  memory: string;
  network: string;
  disk: string;
  uptime: string;
  ports: string;
}

/**
 * Every container with its state, health and live resource use, and an actions menu per
 * container. A table from large screens up; a list of cards below, so nothing scrolls sideways on
 * phones. Shared by the dashboard and the Containers page.
 */
@Component({
  selector: 'app-containers-table',
  imports: [
    ContainerActions,
    HlmBadgeImports,
    HlmCardImports,
    HlmSkeleton,
    HlmTableImports,
    NgTemplateOutlet,
  ],
  templateUrl: './containers-table.html',
})
export class ContainersTable {
  /** Null until the first snapshot. */
  readonly containers = input.required<ContainersSnapshot | null>();
  /**
   * "Now" for uptimes (the dashboard passes the latest system sample's time), so they move with
   * the live data. Without it: the newest stats frame's time, else this device's clock.
   */
  readonly now = input<number | null>(null);

  private readonly clock = computed(() => {
    const given = this.now();
    if (given !== null) return given;
    const snapshot = this.containers();
    const times = snapshot?.dockerAvailable
      ? snapshot.containers.flatMap((c) => (c.stats ? [c.stats.at] : []))
      : [];
    return times.length > 0 ? Math.max(...times) : Date.now();
  });

  protected readonly dockerAvailable = computed(() => this.containers()?.dockerAvailable ?? false);

  protected readonly rows = computed<Row[]>(() => {
    const snapshot = this.containers();
    if (!snapshot?.dockerAvailable) return [];
    return snapshot.containers.map((container) => this.toRow(container));
  });

  protected readonly summary = computed(() => {
    const snapshot = this.containers();
    if (!snapshot) return 'Loading…';
    if (!snapshot.dockerAvailable) return 'Docker not reachable';
    const running = snapshot.containers.filter((c) => c.state === 'running').length;
    return `${running} of ${snapshot.containers.length} running`;
  });

  private toRow(container: Container): Row {
    const { stats } = container;
    const startedAt = container.startedAt ? Date.parse(container.startedAt) : null;
    return {
      id: container.id,
      name: container.name,
      image: container.image,
      stateLabel: STATE_LABELS[container.state],
      stateDot: STATE_DOTS[container.state],
      health:
        container.health === 'none'
          ? null
          : { label: HEALTH_LABELS[container.health], problem: container.health === 'unhealthy' },
      cpu: stats ? formatPercent(stats.cpuPercent) : '—',
      memory: stats
        ? `${formatBytes(stats.memoryUsedBytes)} / ${formatBytes(stats.memoryLimitBytes)}`
        : '—',
      network: stats
        ? `${formatBytes(stats.netRxBytes)} in, ${formatBytes(stats.netTxBytes)} out`
        : '—',
      disk: stats
        ? `${formatBytes(stats.blockReadBytes)} read, ${formatBytes(stats.blockWriteBytes)} written`
        : '—',
      uptime:
        container.state === 'running' && startedAt !== null
          ? formatDuration((this.clock() - startedAt) / 1000)
          : '—',
      ports:
        container.ports
          .map((p) =>
            p.publicPort
              ? `${p.publicPort} → ${p.privatePort}/${p.protocol}`
              : `${p.privatePort}/${p.protocol}`,
          )
          .join(', ') || '—',
    };
  }
}
