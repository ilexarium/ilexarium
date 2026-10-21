import { Component, computed, inject, input } from '@angular/core';
import type { SystemHistoryPoint, SystemSample } from '@laris/shared';
import { HlmCardImports } from '@ui/card';
import { HlmProgressImports } from '@ui/progress';
import { MetricChart } from '../../../shared/charts/metric-chart';
import type { ChartSeries } from '../../../shared/charts/charts.model';
import { TranslatePipe } from '@ngx-translate/core';
import { PluralPipe } from '../../../core/i18n/plural-pipe';
import { Translator } from '../../../core/i18n/translator';
import { Formatter } from '../../../shared/format/formatter';

@Component({
  selector: 'laris-cpu-card',
  imports: [HlmCardImports, HlmProgressImports, MetricChart, PluralPipe, TranslatePipe],
  templateUrl: './cpu-card.html',
})
export class CpuCard {
  readonly cpu = input.required<SystemSample['cpu']>();
  readonly cores = input.required<number>();
  readonly history = input.required<SystemHistoryPoint[]>();
  private readonly translator = inject(Translator);
  private readonly formatter = inject(Formatter);

  protected readonly chart = computed<ChartSeries[]>(() => [
    {
      name: this.translator.t('dashboard.cpu.title'),
      points: this.history().map((p) => [p.at, p.cpuPercent]),
    },
  ]);

  protected readonly usage = computed(() => this.formatter.percent(this.cpu().usagePercent));
  protected readonly load = computed(() =>
    this.cpu()
      .loadAverage.map((value) => this.formatter.decimal(value))
      .join(' · '),
  );
}
