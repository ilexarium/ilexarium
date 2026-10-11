import { Component, computed, input } from '@angular/core';
import type { SystemHistoryPoint, SystemSample } from '@homelab/shared';
import { HlmCardImports } from '@ui/card';
import { HlmProgressImports } from '@ui/progress';
import { type ChartSeries, MetricChart } from '../../../shared/charts/metric-chart';
import { formatPercent } from '../../../shared/format/format';

@Component({
  selector: 'app-cpu-card',
  imports: [HlmCardImports, HlmProgressImports, MetricChart],
  templateUrl: './cpu-card.html',
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
