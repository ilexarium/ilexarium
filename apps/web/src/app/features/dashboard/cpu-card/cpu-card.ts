import { Component, computed, input } from '@angular/core';
import type { SystemHistoryPoint, SystemSample } from '@homelab/shared';
import { HlmCardImports } from '@ui/card';
import { HlmProgressImports } from '@ui/progress';
import { type ChartSeries, MetricChart } from '../../../shared/charts/metric-chart';
import { formatPercent } from '../../../shared/format/format';

@Component({
  selector: 'app-cpu-card',
  imports: [HlmCardImports, HlmProgressImports, MetricChart],
  template: `
    <section hlmCard class="h-full" aria-labelledby="cpu-title">
      <div hlmCardHeader>
        <h2 hlmCardTitle id="cpu-title">CPU</h2>
        <p hlmCardDescription>{{ cores() }} {{ cores() === 1 ? 'core' : 'cores' }}</p>
      </div>
      <div hlmCardContent class="grid gap-3">
        <p class="text-3xl font-semibold tabular-nums">{{ usage() }}</p>
        <hlm-progress [value]="cpu().usagePercent" aria-label="CPU usage">
          <hlm-progress-indicator />
        </hlm-progress>
        <p class="text-sm text-muted-foreground">
          Load {{ load() }} <span class="whitespace-nowrap">(1, 5, 15 min)</span>
        </p>
        <app-metric-chart [series]="chart()" unit="percent" [max]="100" label="CPU usage" />
      </div>
    </section>
  `,
})
export class CpuCard {
  readonly cpu = input.required<SystemSample['cpu']>();
  readonly cores = input.required<number>();
  readonly history = input.required<SystemHistoryPoint[]>();

  protected readonly chart = computed<ChartSeries[]>(() => [
    { name: 'CPU', points: this.history().map((p) => [p.at, p.cpuPercent]) },
  ]);

  protected readonly usage = computed(() => formatPercent(this.cpu().usagePercent));
  protected readonly load = computed(() =>
    this.cpu()
      .loadAverage.map((value) => value.toFixed(2))
      .join(' · '),
  );
}
