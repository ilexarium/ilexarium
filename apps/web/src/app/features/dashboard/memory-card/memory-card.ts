import { Component, computed, input } from '@angular/core';
import type { SystemHistoryPoint, SystemSample } from '@homelab/shared';
import { HlmCardImports } from '@ui/card';
import { HlmProgressImports } from '@ui/progress';
import { MetricChart } from '../../../shared/charts/metric-chart';
import { formatBytes, formatPercent, percentOf } from '../../../shared/format/format';
import type { ChartSeries } from '../../../shared/charts/charts.model';

@Component({
  selector: 'app-memory-card',
  imports: [HlmCardImports, HlmProgressImports, MetricChart],
  templateUrl: './memory-card.html',
})
export class MemoryCard {
  readonly memory = input.required<SystemSample['memory']>();
  readonly history = input.required<SystemHistoryPoint[]>();

  protected readonly chart = computed<ChartSeries[]>(() => [
    { name: 'In use', points: this.history().map((p) => [p.at, p.memoryUsedBytes]) },
  ]);

  protected readonly usedValue = computed(() =>
    percentOf(this.memory().usedBytes, this.memory().totalBytes),
  );
  protected readonly usedPercent = computed(() => formatPercent(this.usedValue()));
  protected readonly used = computed(() => formatBytes(this.memory().usedBytes));
  protected readonly total = computed(() => formatBytes(this.memory().totalBytes));
  protected readonly swap = computed(() => {
    const { swapTotalBytes, swapUsedBytes } = this.memory();
    if (swapTotalBytes === 0) return 'No swap';
    return `Swap: ${formatBytes(swapUsedBytes)} of ${formatBytes(swapTotalBytes)}`;
  });
}
