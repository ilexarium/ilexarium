// The one place raw numbers from the server (bytes, bytes/s, percent, seconds) become text.
// Decimal units (1 GB = 1000³ bytes), as GNOME, macOS and disk makers show them.

const UNITS = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'];

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
function number(value: number, unit: string): string {
  const digits = unit === 'B' || value >= 10 ? 0 : 1;
  return value.toLocaleString('en', {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

/** "3.4 GB" */
export function formatBytes(bytes: number): string {
  const { value, unit } = scaled(bytes);
  return `${number(value, unit)} ${unit}`;
}

/** "1.2 MB/s" */
export function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** "42%" — "<1%" for a small non-zero share, so it never reads as idle when it isn't. */
export function formatPercent(percent: number): string {
  if (percent > 0 && percent < 1) return '<1%';
  return `${Math.round(percent)}%`;
}

/** "3 days, 4 hours" / "4 hours, 12 minutes" / "12 minutes" / "less than a minute". */
export function formatDuration(seconds: number): string {
  const units: [string, number][] = [
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  const parts: string[] = [];
  let rest = Math.floor(Math.max(0, seconds));
  for (const [name, size] of units) {
    const count = Math.floor(rest / size);
    rest %= size;
    if (count > 0 || parts.length > 0) parts.push(`${count} ${name}${count === 1 ? '' : 's'}`);
    if (parts.length === 2) break;
  }
  const shown = parts.filter((part) => !part.startsWith('0 '));
  return shown.length > 0 ? shown.join(', ') : 'less than a minute';
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
