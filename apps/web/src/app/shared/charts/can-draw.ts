/**
 * Whether this environment can draw charts: a 2D canvas and `ResizeObserver`. True in every
 * browser the app supports; false in jsdom (unit tests), where charts render only their
 * accessible description instead of a canvas.
 */
export function canDrawCharts(): boolean {
  return typeof CanvasRenderingContext2D === 'function' && typeof ResizeObserver === 'function';
}
