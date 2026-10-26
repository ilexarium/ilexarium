import { TestBed } from '@angular/core/testing';
import { Sparkline, sparklineSegments } from './sparkline';
import type { SparklineSeries } from './sparkline.model';

describe('sparklineSegments', () => {
  const path = (values: (number | null)[], min = 0, max = 100) =>
    sparklineSegments(values, min, max).map((points) => points.map((p) => `${p.x},${p.y}`));

  it('spreads the values across the width, the lowest at the bottom', () => {
    expect(path([0, 50, 100])).toEqual([['0,58', '150,30', '300,2']]);
  });

  it('keeps values outside the range at its edge', () => {
    expect(path([-10, 200])).toEqual([['0,58', '300,2']]);
  });

  it('leaves a gap where a value is missing, the rest keeping their place in time', () => {
    expect(path([10, 10, null, 10, 10])).toEqual([
      ['0,52.4', '75,52.4'],
      ['225,52.4', '300,52.4'],
    ]);
    expect(path([10, null, 10, 10])).toEqual([['200,52.4', '300,52.4']]);
  });

  it('draws nothing with fewer than two values or an empty range', () => {
    expect(path([5])).toEqual([]);
    expect(path([5, 6], 10, 10)).toEqual([]);
  });
});

describe('Sparkline', () => {
  async function render(series: SparklineSeries[], max?: number) {
    const fixture = TestBed.createComponent(Sparkline);
    fixture.componentRef.setInput('series', series);
    if (max !== undefined) fixture.componentRef.setInput('max', max);
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  it('fills below the first line and dashes the others; hidden from screen readers', async () => {
    const el = await render([
      { values: [1, 2, 3], color: 'var(--chart-1)' },
      { values: [3, 2, 1], color: 'var(--chart-2)' },
    ]);
    expect(el.getAttribute('aria-hidden')).toBe('true');
    const paths = el.querySelectorAll('path');
    expect(paths).toHaveLength(3); // the area and two lines
    expect(paths[0].getAttribute('d')).toMatch(/ Z$/);
    expect(paths[1].getAttribute('stroke-dasharray')).toBeNull();
    expect(paths[2].getAttribute('stroke-dasharray')).toBe('4 3');
  });

  it('scales to a fixed top when given one', async () => {
    const el = await render([{ values: [50, 50], color: 'red' }], 100);
    expect(el.querySelectorAll('path')[1].getAttribute('d')).toBe('M0,30 L300,30');
  });

  it('draws nothing before the second sample', async () => {
    const el = await render([{ values: [5], color: 'red' }]);
    expect(el.querySelectorAll('path')).toHaveLength(0);
  });
});
