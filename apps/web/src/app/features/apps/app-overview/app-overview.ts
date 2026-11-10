import { Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
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
import { appTrends } from '../app-stats';
import type { AppStats, ContainerWithStats } from '../apps.model';

/** The app's CPU and memory, then each of its containers with its own lines and its logs. */
@Component({
  selector: 'ilex-app-overview',
  imports: [NgIcon, RouterLink, Sparkline, StatusDot, TranslatePipe],
  providers: [provideIcons({ lucideCpu, lucideMemoryStick, lucideScrollText })],
  host: { class: 'grid content-start gap-4' },
  templateUrl: './app-overview.html',
})
export class AppOverview {
  readonly stats = input<AppStats | null>(null);
  readonly containers = input.required<ContainerWithStats[]>();

  protected readonly formatter = inject(Formatter);
  protected readonly trends = computed(() => appTrends(this.stats()));
  protected readonly rows = computed(() =>
    this.containers().map(({ container, stats }) => ({
      name: container.name,
      state: container.state,
      dot:
        container.health === 'unhealthy' && container.state === 'running'
          ? UNHEALTHY_DOT
          : STATE_DOTS[container.state],
      cpu: stats ? this.formatter.percent(stats.cpuPercent) : null,
      memory: stats ? this.formatter.bytes(stats.memoryUsedBytes) : null,
      trends: appTrends(stats),
    })),
  );
}
