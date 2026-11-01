import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  catalogIconPath,
  type Container,
  type ContainerAction,
  type ContainerHistoryPoint,
  type ContainersSnapshot,
  type ContainerState,
  type ContainerActionParams,
} from '@laris/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideBox, lucideBoxes, lucideLoaderCircle } from '@ng-icons/lucide';
import { HlmCardImports } from '@ui/card';
import { HlmSkeleton } from '@ui/skeleton';
import { HlmTableImports } from '@ui/table';
import { ContainerActions } from './container-actions';
import { TranslatePipe } from '@ngx-translate/core';
import { Translator } from '../../../core/i18n/translator';
import { Formatter } from '../../../shared/format/formatter';
import { StatusBadge } from '../../../shared/status-badge/status-badge';
import { StatusDot } from '../../../shared/status-dot/status-dot';
import type { DotTone } from '../../../shared/status-dot/status-dot.model';
import {
  CPU_TREND_MIN_TOP,
  HEALTH_TONES,
  STATE_DOTS,
  TREND_COLORS,
  TREND_MIN_POINTS,
  UNHEALTHY_DOT,
} from './containers-table.constants';
import type { StatusTone } from '../../../shared/status-badge/status-badge.model';
import { EmptyState } from '../../../shared/empty-state/empty-state';
import { Sparkline } from '../../../shared/charts/sparkline/sparkline';
import type { SparklineSeries } from '../../../shared/charts/sparkline/sparkline.model';
import type { ContainerGroup } from '../containers.model';

interface Row {
  id: string;
  name: string;
  image: string;
  state: ContainerState;
  protected: boolean;
  stateLabel: string;
  /** "Stopping…" while an action runs. */
  pendingLabel: string | null;
  stateDot: DotTone;
  health: { label: string; tone: StatusTone } | null;
  cpu: string;
  /** Used memory; the limit goes on a second, quieter line. */
  memory: string;
  memoryLimit: string | null;
  /** Recent CPU and memory, as small lines; null without enough points (stopped, just started). */
  cpuTrend: { series: SparklineSeries[]; max: number } | null;
  memoryTrend: SparklineSeries[] | null;
  /** One line per value (in/out, read/written, each port), so the columns stay narrow. */
  network: string[];
  disk: string[];
  uptime: string;
  ports: string[];
}

interface Group {
  key: string;
  /** The app's name, for its heading's link; null: the containers of no app. */
  app: string | null;
  iconUrl: string | null;
  /** "2 of 3 running". */
  summary: string;
  rows: Row[];
}

/**
 * Grouped by app. A table from extra-large screens up (beside the sidebar it needs about 1000 px);
 * a list of cards below, so nothing scrolls sideways on phones and tablets.
 */
@Component({
  selector: 'laris-containers-table',
  imports: [
    EmptyState,
    ContainerActions,
    StatusBadge,
    StatusDot,
    HlmCardImports,
    HlmSkeleton,
    HlmTableImports,
    NgIcon,
    NgTemplateOutlet,
    RouterLink,
    Sparkline,
    TranslatePipe,
  ],
  providers: [provideIcons({ lucideBox, lucideBoxes, lucideLoaderCircle })],
  templateUrl: './containers-table.html',
})
export class ContainersTable {
  /** Null until the first snapshot. */
  readonly containers = input.required<ContainersSnapshot | null>();
  /** The containers by app (from the page's store); the rows' data comes from `containers`. */
  readonly groups = input.required<ContainerGroup[]>();
  /** The action in progress for each container name (from the page's store). */
  readonly pending = input<ReadonlyMap<string, ContainerAction>>(new Map());
  /** A chosen container action — the page's store runs it. */
  readonly action = output<ContainerActionParams>();

  private readonly translator = inject(Translator);
  private readonly formatter = inject(Formatter);

  /** "Now" for uptimes: the newest stats frame's time, so they move with the live data. */
  private readonly clock = computed(() => {
    const snapshot = this.containers();
    const times = snapshot?.dockerAvailable
      ? snapshot.containers.flatMap((c) => (c.stats ? [c.stats.at] : []))
      : [];
    return times.length > 0 ? Math.max(...times) : Date.now();
  });

  protected readonly dockerAvailable = computed(() => this.containers()?.dockerAvailable ?? false);

  protected readonly shownGroups = computed<Group[]>(() => {
    const snapshot = this.containers();
    if (!snapshot?.dockerAvailable) return [];
    return this.groups().map((group) => ({
      key: group.app?.name ?? '',
      app: group.app?.name ?? null,
      iconUrl: group.app?.templateId ? catalogIconPath(group.app.templateId) : null,
      summary: this.translator.t('containers.running', {
        running: group.running,
        total: group.containers.length,
      }),
      rows: group.containers.map((container) =>
        this.toRow(container, snapshot.history[container.id] ?? []),
      ),
    }));
  });

  private toRow(container: Container, history: ContainerHistoryPoint[]): Row {
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
      stateDot:
        container.health === 'unhealthy' && container.state === 'running'
          ? UNHEALTHY_DOT
          : STATE_DOTS[container.state],
      health:
        container.health === 'none'
          ? null
          : {
              label: t(`containers.health.${container.health}`),
              tone: HEALTH_TONES[container.health],
            },
      cpu: stats ? format.percent(stats.cpuPercent) : '—',
      memory: stats ? format.bytes(stats.memoryUsedBytes) : '—',
      memoryLimit: stats
        ? t('containers.memoryOf', { limit: format.bytes(stats.memoryLimitBytes) })
        : null,
      ...trends(container.state === 'running' ? history : []),
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

function trends(history: ContainerHistoryPoint[]): Pick<Row, 'cpuTrend' | 'memoryTrend'> {
  if (history.length < TREND_MIN_POINTS) return { cpuTrend: null, memoryTrend: null };
  const cpu = history.map((p) => p.cpuPercent);
  return {
    // A floor for the top, so an idle container's few tenths of a percent stay a flat line.
    cpuTrend: {
      series: [{ values: cpu, color: TREND_COLORS.cpu }],
      max: Math.max(CPU_TREND_MIN_TOP, ...cpu),
    },
    memoryTrend: [{ values: history.map((p) => p.memoryUsedBytes), color: TREND_COLORS.memory }],
  };
}
