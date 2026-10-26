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
    const highest = Math.max(...this.series().flatMap((s) => s.values.filter((v) => v !== null)));
    return Number.isFinite(highest) && highest > this.min() ? highest * 1.1 : this.min() + 1;
  });

  /** Each series' pieces of line (a missing value is a gap), the first series marked. */
  private readonly drawn = computed(() =>
    this.series().map((s, index) => ({
      color: s.color,
      first: index === 0,
      segments: sparklineSegments(s.values, this.min(), this.top()),
    })),
  );

  protected readonly lines = computed(() =>
    this.drawn()
      .filter((line) => line.segments.length > 0)
      .map((line) => ({
        color: line.color,
        dashed: !line.first,
        d: line.segments.map((points) => `M${points.map(xy).join(' L')}`).join(' '),
      })),
  );

  /** Below the first series' line, piece by piece. */
  protected readonly area = computed(() => {
    const first = this.drawn()[0];
    if (!first || first.segments.length === 0) return null;
    return {
      color: first.color,
      d: first.segments
        .map((points) => {
          const [start, end] = [points[0], points.at(-1)!];
          return `M${points.map(xy).join(' L')} L${end.x},${SPARKLINE_HEIGHT} L${start.x},${SPARKLINE_HEIGHT} Z`;
        })
        .join(' '),
    };
  });
}

interface Point {
  x: number;
  y: number;
}

const xy = ({ x, y }: Point) => `${x},${y}`;

/**
 * The points of the values, spread evenly across the width — a missing value (null) is a gap,
 * so the line keeps its place in time. Pieces of a single point are left out; nothing with
 * fewer than two values.
 */
export function sparklineSegments(values: (number | null)[], min: number, max: number): Point[][] {
  if (values.length < 2 || max <= min) return [];
  // A little room at the top and bottom, so the line's stroke isn't cut off.
  const inner = SPARKLINE_HEIGHT - 4;
  const segments: Point[][] = [[]];
  values.forEach((value, i) => {
    if (value === null) {
      if (segments.at(-1)!.length > 0) segments.push([]);
      return;
    }
    const share = Math.min(1, Math.max(0, (value - min) / (max - min)));
    segments.at(-1)!.push({
      x: round((i * SPARKLINE_WIDTH) / (values.length - 1)),
      y: round(SPARKLINE_HEIGHT - 2 - share * inner),
    });
  });
  return segments.filter((points) => points.length > 1);
}

const round = (n: number) => Math.round(n * 10) / 10;
