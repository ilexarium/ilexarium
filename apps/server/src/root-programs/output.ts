import { StringDecoder } from 'node:string_decoder';

/** Longer lines are cut (a runaway program can't fill the job's output with one line). */
export const MAX_LINE_LENGTH = 4096;
/**
 * A line kept whole until it ends: a `@@result` (e.g. the folders a restore set aside) may be
 * longer than an output line and must reach the parser uncut. Longer still is a runaway line.
 */
export const MAX_PENDING_LENGTH = 256 * 1024;
const MASK = '••••';

/** Bytes in, whole lines out — UTF-8 safe across chunk edges (a chunk may end mid-character). */
export class LineSplitter {
  private readonly decoder = new StringDecoder('utf8');
  private rest = '';

  push(chunk: Buffer): string[] {
    const lines = (this.rest + this.decoder.write(chunk)).split('\n');
    this.rest = lines.pop() ?? '';
    // A line too long to ever end is cut now, not kept growing.
    if (this.rest.length > MAX_PENDING_LENGTH) {
      lines.push(this.rest);
      this.rest = '';
    }
    return lines;
  }

  end(): string[] {
    const last = this.rest + this.decoder.end();
    this.rest = '';
    return last ? [last] : [];
  }
}

/** Colour codes and other control characters out (tabs stay), cut to MAX_LINE_LENGTH. */
export function cleanLine(line: string): string {
  // Matching control characters is the point here.
  // oxlint-disable no-control-regex
  const plain = line
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  // oxlint-enable no-control-regex
  return plain.length > MAX_LINE_LENGTH ? `${plain.slice(0, MAX_LINE_LENGTH)}…` : plain;
}

/** Every secret of the operation replaced, longest first (one may contain another). */
export function maskSecrets(line: string, secrets: readonly string[]): string {
  let masked = line;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret.length >= 4) masked = masked.split(secret).join(MASK);
  }
  return masked;
}

export type WrapperLine =
  | { type: 'phase'; phase: string }
  | { type: 'error'; code: string; field: string | null }
  | { type: 'result'; value: Record<string, unknown> }
  | { type: 'output'; text: string };

const ERROR_MARKER = /^@@error code=([a-z_]{1,40})(?: field=([A-Za-z][A-Za-z0-9_]{0,39}))?$/;

/**
 * One line of wrapper output: its markers (`@@phase`, `@@error`, `@@result`), parsed strictly — a known
 * phase, a plain code, a field-like name, or it's just output — and everything else as text.
 * Compose's lines arrive prefixed with "> " (so they can't pose as markers); the prefix goes.
 */
export function parseWrapperLine(line: string): WrapperLine {
  if (line.startsWith('@@phase ')) {
    const phase = line.slice('@@phase '.length);
    if (/^[a-z]{1,20}$/.test(phase)) return { type: 'phase', phase };
  }
  const error = ERROR_MARKER.exec(line);
  if (error) return { type: 'error', code: error[1], field: error[2] ?? null };
  if (line.startsWith('@@result ')) {
    // A structured result (the backup wrapper's): a JSON object, or it's just output.
    try {
      const value: unknown = JSON.parse(line.slice('@@result '.length));
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        return { type: 'result', value: value as Record<string, unknown> };
      }
    } catch {
      // not JSON
    }
  }
  if (line.startsWith('@@info ')) return { type: 'output', text: line.slice('@@info '.length) };
  if (line.startsWith('> ')) return { type: 'output', text: line.slice(2) };
  if (line === '>') return { type: 'output', text: '' };
  return { type: 'output', text: line };
}
