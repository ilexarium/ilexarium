import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, input, output } from '@angular/core';
import type {
  Container,
  ContainerAction,
  ContainersSnapshot,
  ContainerState,
} from '@homelab/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideLoaderCircle } from '@ng-icons/lucide';
import { HlmBadgeImports } from '@ui/badge';
import { HlmCardImports } from '@ui/card';
import { HlmSkeleton } from '@ui/skeleton';
import { HlmTableImports } from '@ui/table';
import type { ContainerActionRequest } from '../../core/containers/containers.model';
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
  state: ContainerState;
  protected: boolean;
  stateLabel: string;
  /** "Stopping…" while an action runs. */
  pendingLabel: string | null;
  stateDot: string;
  health: { label: string; problem: boolean } | null;
  cpu: string;
  /** Used memory; the limit goes on a second, quieter line. */
  memory: string;
  memoryLimit: string | null;
  /** One line per value (in/out, read/written, each port), so the columns stay narrow. */
  network: string[];
  disk: string[];
  uptime: string;
  ports: string[];
}

/**
 * Every container with its state, health and live resource use, and an actions menu per
 * container. A table from extra-large screens up (beside the sidebar it needs about 930 px); a
 * list of cards below, so nothing scrolls sideways on phones and tablets. Shared by the dashboard and the Containers page.
 */
@Component({
  selector: 'app-containers-table',
  imports: [
    ContainerActions,
    HlmBadgeImports,
    HlmCardImports,
    HlmSkeleton,
    HlmTableImports,
    NgIcon,
    NgTemplateOutlet,
    TranslatePipe,
  ],
  providers: [provideIcons({ lucideLoaderCircle })],
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
  /** The action in progress for each container name (from the page's store). */
  readonly pending = input<ReadonlyMap<string, ContainerAction>>(new Map());
  /** A chosen container action — the page's store runs it. */
  readonly action = output<ContainerActionRequest>();

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
    const pending = this.pending().get(container.name);
    return {
      id: container.id,
      name: container.name,
      image: container.image,
      state: container.state,
      protected: container.protected,
      stateLabel: t(`containers.state.${container.state}`),
      pendingLabel: pending ? t(`containers.pending.${pending}`) : null,
      stateDot: STATE_DOTS[container.state],
      health:
        container.health === 'none'
          ? null
          : {
              label: t(`containers.health.${container.health}`),
              problem: container.health === 'unhealthy',
            },
      cpu: stats ? format.percent(stats.cpuPercent) : '—',
      memory: stats ? format.bytes(stats.memoryUsedBytes) : '—',
      memoryLimit: stats
        ? t('containers.memoryOf', { limit: format.bytes(stats.memoryLimitBytes) })
        : null,
      network: stats
        ? [
            t('containers.networkIn', { rx: format.bytes(stats.netRxBytes) }),
            t('containers.networkOut', { tx: format.bytes(stats.netTxBytes) }),
          ]
        : ['—'],
      disk: stats
        ? [
            t('containers.diskRead', { read: format.bytes(stats.blockReadBytes) }),
            t('containers.diskWritten', { written: format.bytes(stats.blockWriteBytes) }),
          ]
        : ['—'],
      uptime:
        container.state === 'running' && startedAt !== null
          ? format.duration((this.clock() - startedAt) / 1000)
          : '—',
      ports: container.ports.length
        ? container.ports.map((p) =>
            p.publicPort
              ? `${p.publicPort} → ${p.privatePort}/${p.protocol}`
              : `${p.privatePort}/${p.protocol}`,
          )
        : ['—'],
    };
  }
}
