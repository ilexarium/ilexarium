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
  /** The interface's font stack (`--font-sans`), for axis labels and tooltips. */
  font: string;
}

/** What ECharts hands an axis tooltip, per series (`marker` is its own coloured dot, as HTML). */
export interface TooltipItem {
  marker: string;
  seriesName: string;
  value: [number, number];
}
