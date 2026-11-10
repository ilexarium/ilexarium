import { ENV_KEY_PATTERN } from './apps.js';

/**
 * An app's `.env` (what Compose reads for `${VARIABLES}`): read, and changed line by line, so
 * comments, order and lines Ilexarium doesn't know stay as the person wrote them.
 */

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/** A value as Compose reads it: quotes removed, `\"` and `\\` in double quotes, ` #…` after a bare one dropped. */
function unquote(raw: string): string {
  const value = raw.trim();
  if (value.startsWith("'")) {
    const end = value.indexOf("'", 1);
    return end > 0 ? value.slice(1, end) : value.slice(1);
  }
  if (value.startsWith('"')) {
    let out = '';
    for (let i = 1; i < value.length; i++) {
      const char = value[i];
      if (char === '\\' && i + 1 < value.length) {
        const next = value[++i];
        out += next === 'n' ? '\n' : next;
      } else if (char === '"') {
        break;
      } else {
        out += char;
      }
    }
    return out;
  }
  return value.replace(/\s+#.*$/, '');
}

export function parseEnv(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const match = LINE.exec(line);
    if (match) values.set(match[1], unquote(match[2]));
  }
  return values;
}

/** A value written so Compose reads it back exactly: bare when plain, else quoted. */
export function envValue(value: string): string {
  if (/^[A-Za-z0-9_./:@+,%=-]*$/.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Sets these variables: an existing line changed where it is, a new one added at the end. */
export function setEnvValues(text: string, values: Readonly<Record<string, string>>): string {
  const pending = new Map(Object.entries(values).filter(([key]) => ENV_KEY_PATTERN.test(key)));
  const lines = text === '' ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/);
  const out = lines.map((line) => {
    const match = /^\s*#/.test(line) ? null : LINE.exec(line);
    if (!match || !pending.has(match[1])) return line;
    const key = match[1];
    const value = pending.get(key)!;
    pending.delete(key);
    return `${key}=${envValue(value)}`;
  });
  for (const [key, value] of pending) out.push(`${key}=${envValue(value)}`);
  return out.length === 0 ? '' : `${out.join('\n')}\n`;
}
