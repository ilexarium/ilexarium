import { Component, computed, inject, input } from '@angular/core';
import { LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { NgxEchartsDirective, provideEchartsCore } from 'ngx-echarts';
import { formatBytes, formatPercent, formatRate } from '../format/format';
import { canDrawCharts } from './can-draw';
import { ChartColorsService } from './chart-colors';
import type { ChartSeries, ChartUnit } from './charts.model';

// Only what these charts use (line chart, grid, tooltip, canvas) — keeps the chunk small.
echarts.use([LineChart, GridComponent, TooltipComponent, CanvasRenderer]);

const FORMATTERS: Record<ChartUnit, (value: number) => string> = {
  percent: formatPercent,
  bytes: formatBytes,
  rate: formatRate,
};

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
  /** Accessible name, e.g. "CPU usage". */
  readonly label = input.required<string>();
  /** Fixed top of the axis (100 for percentages); otherwise it follows the data. */
  readonly max = input<number | undefined>(undefined);
  readonly windowMs = input(15 * 60_000);

  protected readonly canDraw = canDrawCharts();
  private readonly chartColors = inject(ChartColorsService).colors;

  protected readonly description = computed(() => {
    const format = FORMATTERS[this.unit()];
    const latest = this.series()
      .map((s) => (s.points.length ? `${s.name} ${format(s.points.at(-1)![1])}` : null))
      .filter(Boolean);
    const minutes = Math.round(this.windowMs() / 60_000);
    return `${this.label()}, last ${minutes} minutes${latest.length ? `: now ${latest.join(', ')}` : ''}`;
  });

  protected readonly options = computed<echarts.EChartsCoreOption>(() => {
    const colors = this.chartColors();
    const format = FORMATTERS[this.unit()];
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
