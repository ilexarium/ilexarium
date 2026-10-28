import { handle, type Answer } from './actions.mts';
import { LINE_MAX } from './config.mts';

function answer(id: number | null, result: Answer): void {
  process.stdout.write(`${JSON.stringify({ id, ...result })}\n`);
}

async function request(line: string): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    answer(null, { ok: false, error: 'bad_request' });
    return;
  }
  const id = (parsed as { id?: unknown } | null)?.id;
  if (typeof parsed !== 'object' || Array.isArray(parsed) || !Number.isSafeInteger(id)) {
    answer(null, { ok: false, error: 'bad_request' });
    return;
  }
  try {
    answer(id as number, await handle(parsed as Record<string, unknown>));
  } catch {
    answer(id as number, { ok: false, error: 'failed' });
  }
}

export function start(): void {
  // No echo, no line editing, no signals from the input: requests arrive exactly as sent.
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  let buffer = '';
  // A line too long is refused, and its rest skipped up to the next line break.
  let skipping = false;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end).replace(/\r$/, '');
      buffer = buffer.slice(end + 1);
      if (skipping) {
        skipping = false;
        continue;
      }
      if (line.length > LINE_MAX) answer(null, { ok: false, error: 'bad_request' });
      else if (line.trim()) void request(line);
    }
    if (buffer.length > LINE_MAX) {
      if (!skipping) answer(null, { ok: false, error: 'bad_request' });
      skipping = true;
      buffer = '';
    }
  });
  // The session closed: nothing more to do.
  process.stdin.on('end', () => process.exit(0));
  process.stdout.write(`${JSON.stringify({ 'laris-helper': 1 })}\n`);
}
