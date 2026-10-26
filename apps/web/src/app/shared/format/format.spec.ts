import {
  formatBytes,
  formatClock,
  formatCpuTime,
  formatDuration,
  formatLogTime,
  formatCount,
  formatCelsius,
  formatDecimal,
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

describe('formatClock', () => {
  it('shows the time of day with seconds', () => {
    const at = new Date(2026, 9, 21, 19, 56, 22).getTime(); // local time, in any time zone
    expect(formatClock(at, 'de')).toBe('19:56:22');
    expect(formatClock(at, 'en')).toMatch(/^7:56:22\sPM$/);
  });
});

describe('formatCelsius', () => {
  it('shows whole degrees, as the language writes them', () => {
    expect(formatCelsius(47.6)).toBe('48°C');
    expect(formatCelsius(47.6, 'de-u-nu-latn')).toBe('48 °C');
  });
});

describe('formatDecimal', () => {
  it('keeps the digits asked for, with the language’s decimal mark', () => {
    expect(formatDecimal(0.5)).toBe('0.50');
    expect(formatDecimal(1.234, 'de')).toBe('1,23');
    expect(formatDecimal(2, 'en', 1)).toBe('2.0');
  });
});

describe('formatCount', () => {
  it('shortens large counts', () => {
    expect(formatCount(18)).toBe('18');
    expect(formatCount(52_592)).toBe('52.6K');
    expect(formatCount(1_200_000)).toBe('1.2M');
  });

  it('keeps Latin digits in Arabic', () => {
    expect(formatCount(52_592, 'ar-u-nu-latn')).toMatch(/^52[.,٫]6/);
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

describe('in other languages', () => {
  it('uses the language’s number format', () => {
    expect(formatBytes(3_400_000_000, 'de')).toBe('3,4 GB');
    expect(formatRate(1_200_000, 'de')).toBe('1,2 MB/s');
    // German keeps "42" and "%" together with a non-breaking space.
    expect(formatPercent(42, 'de')).toBe('42\u00a0%');
    expect(formatPercent(0.5, 'de')).toBe('<1\u00a0%');
  });
});

describe('formatDuration', () => {
  it('shows the two largest units', () => {
    expect(formatDuration(3 * 86_400 + 4 * 3_600 + 5 * 60, 'en', 'less than a minute')).toBe(
      '3 days, 4 hours',
    );
    expect(formatDuration(4 * 3_600 + 12 * 60 + 30, 'en', 'less than a minute')).toBe(
      '4 hours, 12 minutes',
    );
    expect(formatDuration(60, 'en', 'less than a minute')).toBe('1 minute');
    expect(formatDuration(86_400 + 30, 'en', 'less than a minute')).toBe('1 day');
    expect(formatDuration(30, 'en', 'less than a minute')).toBe('less than a minute');
  });

  it('is worded by the browser in the language', () => {
    const seconds = 3 * 86_400 + 4 * 3_600;
    expect(formatDuration(seconds, 'de', 'weniger als eine Minute')).toBe('3 Tage, 4 Stunden');
    expect(formatDuration(seconds, 'ar', '')).toBe('3 أيام و4 ساعات');
    expect(formatDuration(5, 'de', 'weniger als eine Minute')).toBe('weniger als eine Minute');
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
        `${pad(local.getHours())}:${pad(local.getMinutes())}:22.123`,
    );
  });

  it('pads small values', () => {
    expect(formatLogTime('2026-01-02T00:00:00.000000000Z')).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:00\.000$/,
    );
  });
});

describe('formatCpuTime', () => {
  it('is htop’s TIME+: minutes, seconds and hundredths below an hour, then hours', () => {
    expect(formatCpuTime(0)).toBe('0:00.00');
    expect(formatCpuTime(247.31)).toBe('4:07.31');
    expect(formatCpuTime(3600 * 12 + 4 * 60 + 31.9)).toBe('12:04:31');
    expect(formatCpuTime(3600 * 153)).toBe('153h');
    expect(formatCpuTime(-5)).toBe('0:00.00');
    // From clock ticks: 29 / 100 * 100 is 28.999… in floating point.
    expect(formatCpuTime(29 / 100)).toBe('0:00.29');
  });
});
