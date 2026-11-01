import { Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { Container, ContainerHistoryPoint } from '@laris/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCpu, lucideMemoryStick, lucideScrollText } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { Sparkline } from '../../../shared/charts/sparkline/sparkline';
import { Formatter } from '../../../shared/format/formatter';
import { StatusDot } from '../../../shared/status-dot/status-dot';
import {
  STATE_DOTS,
  UNHEALTHY_DOT,
} from '../../containers/containers-table/containers-table.constants';
import { appStats, appTrends } from '../app-stats';
import type { AppStats } from '../apps.model';

/** The app's CPU and memory (summed), then each of its containers with its own lines and logs. */
@Component({
  selector: 'laris-app-overview',
  imports: [NgIcon, RouterLink, Sparkline, StatusDot, TranslatePipe],
  providers: [provideIcons({ lucideCpu, lucideMemoryStick, lucideScrollText })],
  host: { class: 'grid content-start gap-4' },
  templateUrl: './app-overview.html',
})
export class AppOverview {
  readonly stats = input<AppStats | null>(null);
  readonly containers = input.required<Container[]>();
  readonly history = input.required<Readonly<Record<string, ContainerHistoryPoint[]>>>();

  protected readonly formatter = inject(Formatter);
  protected readonly trends = computed(() => appTrends(this.stats()));
  protected readonly rows = computed(() =>
    this.containers().map((container) => {
      const stats = appStats([container], this.history());
      return {
        name: container.name,
        state: container.state,
        dot:
          container.health === 'unhealthy' && container.state === 'running'
            ? UNHEALTHY_DOT
            : STATE_DOTS[container.state],
        cpu: stats ? this.formatter.percent(stats.cpuPercent) : null,
        memory: stats ? this.formatter.bytes(stats.memoryUsedBytes) : null,
        trends: appTrends(stats),
      };
    }),
  );
}
