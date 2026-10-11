import { TestBed } from '@angular/core/testing';
import { ChartColorsService } from './chart-colors';

describe('ChartColorsService', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('style');
    document.documentElement.className = '';
  });

  it('reads the chart colours from the theme tokens', () => {
    document.documentElement.style.setProperty('--chart-1', 'rgb(1, 2, 3)');
    const colors = TestBed.inject(ChartColorsService).colors();
    expect(colors.series[0]).toBe('rgb(1, 2, 3)');
    expect(colors.series).toHaveLength(5);
  });

  it('follows a theme change on <html> (light ↔ dark)', async () => {
    document.documentElement.style.setProperty('--chart-1', 'rgb(1, 2, 3)');
    const service = TestBed.inject(ChartColorsService);
    document.documentElement.style.setProperty('--chart-1', 'rgb(9, 9, 9)');
    document.documentElement.classList.add('dark');
    await vi.waitFor(() => expect(service.colors().series[0]).toBe('rgb(9, 9, 9)'));
  });
});
