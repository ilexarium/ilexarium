export interface SparklineSeries {
  /** Oldest first, one every sample; null where there was none (a gap in the line). */
  values: (number | null)[];
  /** A CSS colour, e.g. `var(--chart-1)`. */
  color: string;
}
