import { Component, computed, inject, input } from '@angular/core';
import { LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { NgxEchartsDirective, provideEchartsCore } from 'ngx-echarts';
import { canDrawCharts } from './can-draw';
import { ChartColorsService } from './chart-colors';
import { HISTORY_WINDOW_MS } from '@laris/shared';
import type { ChartSeries, ChartUnit } from './charts.model';
import { Translator } from '../../core/i18n/translator';
import { Formatter } from '../format/formatter';

/** What ECharts hands an axis tooltip, per series (`marker` is its own coloured dot, as HTML). */
interface TooltipItem {
  marker: string;
  seriesName: string;
  value: [number, number];
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Only what these charts use (line chart, grid, tooltip, canvas) — keeps the chunk small.
echarts.use([LineChart, GridComponent, TooltipComponent, CanvasRenderer]);

/** The canvas is hidden from screen readers: `label` and the latest values describe the chart. */
@Component({
  selector: 'laris-metric-chart',
  imports: [NgxEchartsDirective],
  providers: [provideEchartsCore({ echarts })],
  host: { class: 'block' },
  templateUrl: './metric-chart.html',
})
export class MetricChart {
  readonly series = input.required<ChartSeries[]>();
  readonly unit = input.required<ChartUnit>();
  /** Translated by the caller, like the series names. */
  readonly label = input.required<string>();
  /** Fixed top of the axis (100 for percentages); otherwise it follows the data. */
  readonly max = input<number | undefined>(undefined);

  protected readonly canDraw = canDrawCharts();
  private readonly chartColors = inject(ChartColorsService).colors;
  private readonly translator = inject(Translator);
  private readonly formatter = inject(Formatter);

  /** The units are `Formatter`'s method names. */
  private format(unit: ChartUnit): (value: number) => string {
    return (value) => this.formatter[unit](value);
  }

  protected readonly description = computed(() => {
    const format = this.format(this.unit());
    const latest = this.series()
      .map((s) => (s.points.length ? `${s.name} ${format(s.points.at(-1)![1])}` : null))
      .filter(Boolean);
    const minutes = Math.round(HISTORY_WINDOW_MS / 60_000);
    const description = this.translator.plural('chart.lastMinutes', minutes, {
      label: this.label(),
    });
    return latest.length
      ? this.translator.t('chart.now', { description, values: latest.join(', ') })
      : description;
  });

  private tooltip(items: TooltipItem[], format: (value: number) => string): string {
    const at = items[0]?.value[0];
    const rows = items.map(
      (item) => `${item.marker} ${escapeHtml(item.seriesName)} <b>${format(item.value[1])}</b>`,
    );
    return [at === undefined ? '' : this.formatter.clock(at), ...rows].join('<br>');
  }

  protected readonly options = computed<echarts.EChartsCoreOption>(() => {
    const colors = this.chartColors();
    const format = this.format(this.unit());
    const series = this.series();
    const end = Math.max(0, ...series.map((s) => s.points.at(-1)?.[0] ?? 0));
    return {
      animation: false,
      color: colors.series,
      textStyle: { fontFamily: colors.font },
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
        // ECharts' own time ("2026-10-21 21:56:22") ignores the language: ours instead.
        formatter: (params: unknown) => this.tooltip(params as TooltipItem[], format),
      },
      xAxis: {
        type: 'time',
        min: end ? end - HISTORY_WINDOW_MS : undefined,
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
