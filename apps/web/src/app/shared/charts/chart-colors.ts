import { DestroyRef, DOCUMENT, inject, Service, signal } from '@angular/core';
import { canDrawCharts } from './can-draw';
import type { ChartColors } from './charts.model';

const SERIES_TOKENS = ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5'];

/**
 * Chart colours from the CSS theme tokens (`styles.css`), re-read when the theme class on
 * `<html>` changes, so charts follow light and dark mode. Tokens are `oklch(…)`, which ECharts'
 * own colour maths doesn't understand: they are converted to `rgb(…)` through a 1×1 canvas.
 */
@Service()
export class ChartColorsService {
  private readonly document = inject(DOCUMENT);
  private readonly current = signal(this.read());

  readonly colors = this.current.asReadonly();

  constructor() {
    const view = this.document.defaultView;
    if (!view || typeof view.MutationObserver !== 'function') return;
    const observer = new view.MutationObserver(() => this.current.set(this.read()));
    observer.observe(this.document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
    inject(DestroyRef).onDestroy(() => observer.disconnect());
  }

  private read(): ChartColors {
    const style = this.document.defaultView?.getComputedStyle(this.document.documentElement);
    const token = (name: string, fallback: string) =>
      this.toRgb(style?.getPropertyValue(name).trim() || fallback);
    return {
      series: SERIES_TOKENS.map((name, i) =>
        token(name, ['#544ccb', '#009589', '#da950b', '#cd5394', '#1292c0'][i]),
      ),
      text: token('--muted-foreground', '#5f6177'),
      grid: token('--border', '#e1e2ec'),
      tooltipBackground: token('--popover', '#ffffff'),
      tooltipText: token('--popover-foreground', '#151628'),
    };
  }

  /** Any CSS colour → `rgb(…)`/`rgba(…)`; unchanged where there is no canvas (tests). */
  private toRgb(color: string): string {
    if (!canDrawCharts()) return color;
    const canvas = this.document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return color;
    canvas.width = canvas.height = 1;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
    return a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(2)})`;
  }
}
