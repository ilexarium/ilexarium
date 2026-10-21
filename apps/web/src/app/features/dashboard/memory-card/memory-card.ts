import { Component, computed, inject, input } from '@angular/core';
import type { SystemHistoryPoint, SystemSample } from '@laris/shared';
import { HlmCardImports } from '@ui/card';
import { HlmProgressImports } from '@ui/progress';
import { MetricChart } from '../../../shared/charts/metric-chart';
import { percentOf } from '../../../shared/format/format';
import type { ChartSeries } from '../../../shared/charts/charts.model';
import { TranslatePipe } from '@ngx-translate/core';
import { Translator } from '../../../core/i18n/translator';
import { Formatter } from '../../../shared/format/formatter';

@Component({
  selector: 'laris-memory-card',
  imports: [HlmCardImports, HlmProgressImports, MetricChart, TranslatePipe],
  templateUrl: './memory-card.html',
})
export class MemoryCard {
  readonly memory = input.required<SystemSample['memory']>();
  readonly history = input.required<SystemHistoryPoint[]>();
  private readonly translator = inject(Translator);
  private readonly formatter = inject(Formatter);

  protected readonly chart = computed<ChartSeries[]>(() => [
    {
      name: this.translator.t('dashboard.memory.series'),
      points: this.history().map((p) => [p.at, p.memoryUsedBytes]),
    },
  ]);

  protected readonly usedValue = computed(() =>
    percentOf(this.memory().usedBytes, this.memory().totalBytes),
  );
  protected readonly usedPercent = computed(() => this.formatter.percent(this.usedValue()));
  protected readonly used = computed(() => this.formatter.bytes(this.memory().usedBytes));
  protected readonly total = computed(() => this.formatter.bytes(this.memory().totalBytes));
  protected readonly swap = computed(() => {
    const { swapTotalBytes, swapUsedBytes } = this.memory();
    if (swapTotalBytes === 0) return this.translator.t('dashboard.memory.noSwap');
    return this.translator.t('dashboard.memory.swap', {
      used: this.formatter.bytes(swapUsedBytes),
      total: this.formatter.bytes(swapTotalBytes),
    });
  });
}
