import {
  formatBytes,
  formatDuration,
  formatLogTime,
  formatPercent,
  formatRate,
  percentOf,
} from './format';

describe('formatBytes', () => {
  it('uses decimal units, one decimal below 10', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1000)).toBe('1.0 kB');
    expect(formatBytes(3_400_000_000)).toBe('3.4 GB');
    expect(formatBytes(512_000_000)).toBe('512 MB');
    expect(formatBytes(12_510_502_912)).toBe('13 GB');
    expect(formatBytes(2.5e15)).toBe('2.5 PB');
  });

  it('never shows a negative size', () => {
    expect(formatBytes(-5)).toBe('0 B');
  });
});

describe('formatRate', () => {
  it('is bytes per second', () => {
    expect(formatRate(1_200_000)).toBe('1.2 MB/s');
    expect(formatRate(0)).toBe('0 B/s');
  });
});

describe('formatPercent', () => {
  it('rounds, and shows a small non-zero share as <1%', () => {
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(0.2)).toBe('<1%');
    expect(formatPercent(42.6)).toBe('43%');
    expect(formatPercent(250)).toBe('250%');
  });
});

describe('formatDuration', () => {
  it('shows the two largest units', () => {
    expect(formatDuration(3 * 86_400 + 4 * 3_600 + 5 * 60)).toBe('3 days, 4 hours');
    expect(formatDuration(4 * 3_600 + 12 * 60 + 30)).toBe('4 hours, 12 minutes');
    expect(formatDuration(60)).toBe('1 minute');
    expect(formatDuration(86_400 + 30)).toBe('1 day');
    expect(formatDuration(30)).toBe('less than a minute');
  });
});

describe('percentOf', () => {
  it('is 0 for an empty total', () => {
    expect(percentOf(5, 0)).toBe(0);
    expect(percentOf(45, 50)).toBe(90);
  });
});

describe('formatLogTime', () => {
  it('shows a Docker timestamp in local time, to the millisecond', () => {
    const at = '2026-10-11T12:03:22.123456789Z';
    // Built from the same instant in this machine's time zone, whatever it is.
    const local = new Date(Date.UTC(2026, 9, 11, 12, 3, 22, 123));
    const pad = (n: number) => String(n).padStart(2, '0');
    expect(formatLogTime(at)).toBe(
      `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())} ` +
        `${pad(local.getHours())}:03:22.123`,
    );
  });

  it('pads small values', () => {
    expect(formatLogTime('2026-01-02T00:00:00.000000000Z')).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:00\.000$/,
    );
  });
});
