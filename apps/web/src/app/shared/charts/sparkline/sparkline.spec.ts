import { TestBed } from '@angular/core/testing';
import { Sparkline, sparklinePath } from './sparkline';
import type { SparklineSeries } from './sparkline.model';

describe('sparklinePath', () => {
  it('spreads the values across the width, the lowest at the bottom', () => {
    expect(sparklinePath([0, 50, 100], 0, 100)).toBe('M0,58 L150,30 L300,2');
  });

  it('keeps values outside the range at its edge', () => {
    expect(sparklinePath([-10, 200], 0, 100)).toBe('M0,58 L300,2');
  });

  it('draws nothing with fewer than two values or an empty range', () => {
    expect(sparklinePath([5], 0, 100)).toBeNull();
    expect(sparklinePath([5, 6], 10, 10)).toBeNull();
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
