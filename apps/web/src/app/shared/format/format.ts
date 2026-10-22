// The one place raw numbers from the server (bytes, bytes/s, percent, seconds) become text, in a
// language's own number format (`Formatter` passes the current one). Decimal units (1 GB = 1000³
// bytes), as GNOME, macOS and disk makers show them; unit symbols aren't translated.

import { UNITS } from './format.constants';

function scaled(bytes: number): { value: number; unit: string } {
  let value = Math.max(0, bytes);
  let index = 0;
  while (value >= 1000 && index < UNITS.length - 1) {
    value /= 1000;
    index++;
  }
  return { value, unit: UNITS[index] };
}

/** One decimal below 10, none above ("3.4 GB", "512 MB"); whole bytes. */
function number(value: number, unit: string, locale: string): string {
  const digits = unit === 'B' || value >= 10 ? 0 : 1;
  return value.toLocaleString(locale, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

/** "3.4 GB" ("3,4 GB" in German) */
export function formatBytes(bytes: number, locale = 'en'): string {
  const { value, unit } = scaled(bytes);
  return `${number(value, unit, locale)} ${unit}`;
}

/** "1.2 MB/s" */
export function formatRate(bytesPerSecond: number, locale = 'en'): string {
  return `${formatBytes(bytesPerSecond, locale)}/s`;
}

/** A count, short: "52K", "1.2M" (downloads, likes). */
export function formatCount(count: number, locale = 'en'): string {
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(
    count,
  );
}

export function formatDecimal(value: number, locale = 'en', digits = 2): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

/** "42%" ("42 %" in German) — "<1%" for a small non-zero share, so it never reads as idle. */
export function formatPercent(percent: number, locale = 'en'): string {
  const format = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 });
  if (percent > 0 && percent < 1) return `<${format.format(0.01)}`;
  return format.format(Math.round(percent) / 100);
}

/**
 * The two largest units: "3 days, 4 hours" / "4 hours, 12 minutes" / "12 minutes" — worded by the
 * browser in the language (`Intl.DurationFormat`); `lessThanAMinute` (translated) below a minute.
 */
export function formatDuration(seconds: number, locale: string, lessThanAMinute: string): string {
  const units = [
    ['days', 86_400],
    ['hours', 3_600],
    ['minutes', 60],
  ] as const;
  const parts: Partial<Record<(typeof units)[number][0], number>> = {};
  let rest = Math.floor(Math.max(0, seconds));
  let taken = 0;
  for (const [name, size] of units) {
    const count = Math.floor(rest / size);
    rest %= size;
    if (count > 0 || taken > 0) {
      if (count > 0) parts[name] = count;
      if (++taken === 2) break;
    }
  }
  if (Object.keys(parts).length === 0) return lessThanAMinute;
  return new Intl.DurationFormat(locale, { style: 'long' }).format(parts);
}

/** Used share of a total as a percentage (0 for an empty total). */
export function percentOf(used: number, total: number): number {
  return total > 0 ? (used / total) * 100 : 0;
}

/**
 * A log line's time in this device's time zone, to the millisecond: "2026-10-11 14:03:22.123".
 * Takes Docker's timestamp (nanoseconds, UTC); the digits beyond milliseconds are dropped.
 */
export function formatLogTime(at: string): string {
  const date = new Date(`${at.slice(0, 23)}Z`);
  const pad = (value: number, length = 2) => String(value).padStart(length, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}`
  );
}

/** A moment as date and time, in the language's own way (e.g. "14 Oct 2026, 03:00"). */
export function formatDateTime(at: string, locale = 'en'): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(at),
  );
}

/** The time of day with seconds, in the language's own way (e.g. "21:56:22", "9:56:22 PM"). */
export function formatClock(at: number, locale = 'en'): string {
  return new Intl.DateTimeFormat(locale, { timeStyle: 'medium' }).format(new Date(at));
}

/** A day, in the language's own way (e.g. "14 Oct 2026"). */
export function formatDate(at: string, locale = 'en'): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(at));
}
