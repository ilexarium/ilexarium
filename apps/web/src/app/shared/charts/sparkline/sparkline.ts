import { Component, computed, input } from '@angular/core';
import { SPARKLINE_HEIGHT, SPARKLINE_WIDTH } from './sparkline.constants';
import type { SparklineSeries } from './sparkline.model';

/**
 * A small line of recent values, without axes: the trend at a glance. Decorative — the text
 * beside it (the current value, in words) says what it shows, so it's hidden from screen readers.
 * Drawn left to right in every language: time runs that way on charts.
 */
@Component({
  selector: 'laris-sparkline',
  host: { class: 'block', 'aria-hidden': 'true' },
  templateUrl: './sparkline.html',
})
export class Sparkline {
  /** The first series is filled below its line; others are dashed lines. */
  readonly series = input.required<SparklineSeries[]>();
  readonly min = input(0);
  /** Fixed top (100 for percentages); otherwise the highest value shown. */
  readonly max = input<number | undefined>(undefined);

  protected readonly width = SPARKLINE_WIDTH;
  protected readonly height = SPARKLINE_HEIGHT;

  private readonly top = computed(() => {
    const max = this.max();
    if (max !== undefined) return max;
    const highest = Math.max(...this.series().flatMap((s) => s.values));
    return Number.isFinite(highest) && highest > this.min() ? highest * 1.1 : this.min() + 1;
  });

  protected readonly lines = computed(() =>
    this.series()
      .map((s) => ({ color: s.color, d: sparklinePath(s.values, this.min(), this.top()) }))
      .filter((line) => line.d !== null),
  );

  protected readonly area = computed(() => {
    const first = this.lines()[0];
    return first
      ? `${first.d} L${SPARKLINE_WIDTH},${SPARKLINE_HEIGHT} L0,${SPARKLINE_HEIGHT} Z`
      : null;
  });
}

/** The line through the values, spread evenly across the width; null with fewer than two. */
export function sparklinePath(values: number[], min: number, max: number): string | null {
  if (values.length < 2 || max <= min) return null;
  // A little room at the top and bottom, so the line's stroke isn't cut off.
  const inner = SPARKLINE_HEIGHT - 4;
  const points = values.map((value, i) => {
    const x = (i * SPARKLINE_WIDTH) / (values.length - 1);
    const share = Math.min(1, Math.max(0, (value - min) / (max - min)));
    const y = SPARKLINE_HEIGHT - 2 - share * inner;
    return `${round(x)},${round(y)}`;
  });
  return `M${points.join(' L')}`;
}

const round = (n: number) => Math.round(n * 10) / 10;
