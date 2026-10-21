import { TestBed } from '@angular/core/testing';
import { MetricChart } from './metric-chart';
import type { ChartSeries, ChartUnit } from './charts.model';

interface Options {
  xAxis: { min?: number; max?: number };
  yAxis: { max?: number; axisLabel: { formatter: (value: number) => string } };
  tooltip: { formatter: (items: unknown) => string };
  series: { name: string; data: [number, number][] }[];
  color: string[];
}

async function render(series: ChartSeries[], unit: ChartUnit, max?: number) {
  const fixture = TestBed.createComponent(MetricChart);
  fixture.componentRef.setInput('series', series);
  fixture.componentRef.setInput('unit', unit);
  fixture.componentRef.setInput('label', 'Network traffic');
  if (max !== undefined) fixture.componentRef.setInput('max', max);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const options = (fixture.componentInstance as unknown as { options: () => Options }).options();
  return { el, options };
}

const MINUTE = 60_000;
const series: ChartSeries[] = [
  {
    name: 'Receiving',
    points: [
      [10 * MINUTE, 1_000],
      [11 * MINUTE, 1_200_000],
    ],
  },
  {
    name: 'Sending',
    points: [
      [10 * MINUTE, 0],
      [11 * MINUTE, 300_000],
    ],
  },
];

describe('MetricChart', () => {
  it('describes itself for screen readers, with the latest values', async () => {
    const { el } = await render(series, 'rate');
    expect(el.querySelector('[role="img"]')!.getAttribute('aria-label')).toBe(
      'Network traffic, last 15 minutes: now Receiving 1.2 MB/s, Sending 300 kB/s',
    );
  });

  it('describes an empty chart without values', async () => {
    const { el } = await render([{ name: 'CPU', points: [] }], 'percent');
    expect(el.querySelector('[role="img"]')!.getAttribute('aria-label')).toBe(
      'Network traffic, last 15 minutes',
    );
  });

  it('shows a fixed 15-minute window ending at the latest point', async () => {
    const { options } = await render(series, 'rate');
    expect(options.xAxis.max).toBe(11 * MINUTE);
    expect(options.xAxis.min).toBe(11 * MINUTE - 15 * MINUTE);
  });

  it('plots each series with the theme colours, formatted in its unit', async () => {
    const { options } = await render(series, 'rate');
    expect(options.series.map((s) => s.name)).toEqual(['Receiving', 'Sending']);
    expect(options.series[0].data).toEqual(series[0].points);
    expect(options.color).toHaveLength(5);
    expect(options.yAxis.axisLabel.formatter(1_500_000)).toBe('1.5 MB/s');
  });

  it('words the tooltip: the time of day, then each series in its unit', async () => {
    const { options } = await render(series, 'rate');
    const html = options.tooltip.formatter([
      { marker: '<i></i>', seriesName: 'Receiving', value: [11 * MINUTE, 1_200_000] },
      { marker: '<i></i>', seriesName: '<b>Sending</b>', value: [11 * MINUTE, 42.4] },
    ]);
    const [time, ...rows] = html.split('<br>');
    expect(time).toMatch(/\d:11:00/);
    expect(rows).toEqual([
      '<i></i> Receiving <b>1.2 MB/s</b>',
      '<i></i> &#60;b&#62;Sending&#60;/b&#62; <b>42 B/s</b>',
    ]);
  });

  it('caps the axis when given a maximum (100 for percentages)', async () => {
    const { options } = await render([{ name: 'CPU', points: [[1, 50]] }], 'percent', 100);
    expect(options.yAxis.max).toBe(100);
    expect(options.yAxis.axisLabel.formatter(50)).toBe('50%');
  });
});
