import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, input } from '@angular/core';
import type { Container, ContainersSnapshot, ContainerState } from '@homelab/shared';
import { HlmBadgeImports } from '@ui/badge';
import { HlmCardImports } from '@ui/card';
import { HlmSkeleton } from '@ui/skeleton';
import { HlmTableImports } from '@ui/table';
import { ContainerActions } from './container-actions';
import { TranslatePipe } from '@ngx-translate/core';
import { Translator } from '../../core/i18n/translator';
import { Formatter } from '../format/formatter';

const STATE_DOTS: Record<ContainerState, string> = {
  running: 'bg-emerald-500',
  created: 'bg-muted-foreground',
  restarting: 'bg-amber-500',
  paused: 'bg-amber-500',
  removing: 'bg-muted-foreground',
  exited: 'bg-muted-foreground',
  dead: 'bg-destructive',
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
    TranslatePipe,
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

  private readonly translator = inject(Translator);
  private readonly formatter = inject(Formatter);

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
    if (!snapshot) return this.translator.t('containers.loading');
    if (!snapshot.dockerAvailable) return this.translator.t('containers.dockerUnavailable');
    const running = snapshot.containers.filter((c) => c.state === 'running').length;
    return this.translator.t('containers.running', { running, total: snapshot.containers.length });
  });

  private toRow(container: Container): Row {
    const { stats } = container;
    const t = this.translator.t.bind(this.translator);
    const format = this.formatter;
    const startedAt = container.startedAt ? Date.parse(container.startedAt) : null;
    return {
      id: container.id,
      name: container.name,
      image: container.image,
      stateLabel: t(`containers.state.${container.state}`),
      stateDot: STATE_DOTS[container.state],
      health:
        container.health === 'none'
          ? null
          : {
              label: t(`containers.health.${container.health}`),
              problem: container.health === 'unhealthy',
            },
      cpu: stats ? format.percent(stats.cpuPercent) : '—',
      memory: stats
        ? t('containers.memoryValue', {
            used: format.bytes(stats.memoryUsedBytes),
            limit: format.bytes(stats.memoryLimitBytes),
          })
        : '—',
      network: stats
        ? t('containers.networkValue', {
            rx: format.bytes(stats.netRxBytes),
            tx: format.bytes(stats.netTxBytes),
          })
        : '—',
      disk: stats
        ? t('containers.diskValue', {
            read: format.bytes(stats.blockReadBytes),
            written: format.bytes(stats.blockWriteBytes),
          })
        : '—',
      uptime:
        container.state === 'running' && startedAt !== null
          ? format.duration((this.clock() - startedAt) / 1000)
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
