import { Component, computed, inject, input } from '@angular/core';
import { LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { NgxEchartsDirective, provideEchartsCore } from 'ngx-echarts';
import { canDrawCharts } from './can-draw';
import { ChartColorsService } from './chart-colors';
import type { ChartSeries, ChartUnit } from './charts.model';
import { Translator } from '../../core/i18n/translator';
import { Formatter } from '../format/formatter';

// Only what these charts use (line chart, grid, tooltip, canvas) — keeps the chunk small.
echarts.use([LineChart, GridComponent, TooltipComponent, CanvasRenderer]);

/**
 * A small live line chart of the last `windowMs` (15 minutes by default). The canvas is hidden
 * from screen readers; the chart is described by `label` plus a summary of the latest values
 * (the card around it shows the current numbers as text anyway).
 */
@Component({
  selector: 'app-metric-chart',
  imports: [NgxEchartsDirective],
  providers: [provideEchartsCore({ echarts })],
  host: { class: 'block' },
  templateUrl: './metric-chart.html',
})
export class MetricChart {
  readonly series = input.required<ChartSeries[]>();
  readonly unit = input.required<ChartUnit>();
  /** Accessible name, e.g. "CPU usage" (translated by the caller, like the series names). */
  readonly label = input.required<string>();
  /** Fixed top of the axis (100 for percentages); otherwise it follows the data. */
  readonly max = input<number | undefined>(undefined);
  readonly windowMs = input(15 * 60_000);

  protected readonly canDraw = canDrawCharts();
  private readonly chartColors = inject(ChartColorsService).colors;
  private readonly translator = inject(Translator);
  private readonly formatter = inject(Formatter);

  private format(unit: ChartUnit): (value: number) => string {
    const formatter = this.formatter;
    return { percent: formatter.percent, bytes: formatter.bytes, rate: formatter.rate }[unit].bind(
      formatter,
    );
  }

  protected readonly description = computed(() => {
    const format = this.format(this.unit());
    const latest = this.series()
      .map((s) => (s.points.length ? `${s.name} ${format(s.points.at(-1)![1])}` : null))
      .filter(Boolean);
    const minutes = Math.round(this.windowMs() / 60_000);
    const description = this.translator.plural('chart.lastMinutes', minutes, {
      label: this.label(),
    });
    return latest.length
      ? this.translator.t('chart.now', { description, values: latest.join(', ') })
      : description;
  });

  protected readonly options = computed<echarts.EChartsCoreOption>(() => {
    const colors = this.chartColors();
    const format = this.format(this.unit());
    const series = this.series();
    const end = Math.max(0, ...series.map((s) => s.points.at(-1)?.[0] ?? 0));
    return {
      animation: false,
      color: colors.series,
      grid: {
        left: 4,
        right: 8,
        top: 8,
        bottom: 4,
        containLabel: true,
      },
      tooltip: {
        trigger: 'axis',
        backgroundColor: colors.tooltipBackground,
        borderColor: colors.grid,
        textStyle: { color: colors.tooltipText, fontSize: 12 },
        valueFormatter: (value: unknown) => (typeof value === 'number' ? format(value) : ''),
      },
      xAxis: {
        type: 'time',
        min: end ? end - this.windowMs() : undefined,
        max: end || undefined,
        axisLabel: { show: false },
        axisTick: { show: false },
        axisLine: { lineStyle: { color: colors.grid } },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        min: 0,
        max: this.max(),
        splitNumber: 2,
        axisLabel: {
          color: colors.text,
          fontSize: 10,
          formatter: (value: number) => format(value),
        },
        splitLine: { lineStyle: { color: colors.grid } },
      },
      series: series.map((s) => ({
        name: s.name,
        type: 'line',
        data: s.points,
        showSymbol: false,
        lineStyle: { width: 1.5 },
        areaStyle: { opacity: 0.15 },
      })),
    };
  });
}
