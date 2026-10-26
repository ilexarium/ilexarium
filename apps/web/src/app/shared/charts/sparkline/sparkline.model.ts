export interface SparklineSeries {
  /** Oldest first, one every sample. */
  values: number[];
  /** A CSS colour, e.g. `var(--chart-1)`. */
  color: string;
}
