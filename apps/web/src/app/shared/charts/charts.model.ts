export type ChartUnit = 'percent' | 'bytes' | 'rate';

export interface ChartSeries {
  name: string;
  /** [epoch ms, value], oldest first. */
  points: [number, number][];
}

/** The theme tokens charts use, as colours ECharts can work with. */
export interface ChartColors {
  series: string[];
  text: string;
  grid: string;
  tooltipBackground: string;
  tooltipText: string;
}
