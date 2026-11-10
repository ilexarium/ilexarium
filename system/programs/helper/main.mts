import { handle, type Answer, type Request } from './actions.mts';
import { LINE_MAX } from './config.mts';
import { endRoot } from './sudo.mts';
import { readLines } from '../lib/lines.mts';

function answer(id: number | null, result: Answer): void {
  process.stdout.write(`${JSON.stringify({ id, ...result })}\n`);
}

async function request(
  line: string,
  handler: (request: Request) => Promise<Answer> | Answer,
): Promise<void> {
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
    answer(id as number, await handler(parsed as Request));
  } catch {
    answer(id as number, { ok: false, error: 'failed' });
  }
}
// serve brings a line together form sdtin, then passes it to request which parses it and answers with
// the id and the result of calling the handler (from actions.mts) the answer is written to stdout
// back through the channel to the server

/**
 * Answers JSON requests on stdin, one per line, until stdin ends — then exits once the requests
 * still running are answered (`onEnd` runs at once). `idleMs`: it also exits that long after its
 * last request.
 */
export function serve(
  ready: string,
  handler: (request: Request) => Promise<Answer> | Answer,
  options: { idleMs?: number; onEnd?: () => void } = {},
): void {
  const { idleMs, onEnd } = options;
  let running = 0;
  let ended = false;
  let idle: NodeJS.Timeout | undefined;
  const settle = () => {
    if (running > 0) return;
    if (ended) process.exit(0);
    if (idleMs !== undefined) {
      clearTimeout(idle);
      idle = setTimeout(() => process.exit(0), idleMs);
    }
  };
  const take = (line: string) => {
    running += 1;
    clearTimeout(idle);
    void request(line, handler).finally(() => {
      running -= 1;
      settle();
    });
  };
  // A line too long is refused, and its rest skipped up to the next line break.
  readLines(
    process.stdin,
    LINE_MAX,
    (line) => {
      if (line.trim()) take(line);
    },
    () => answer(null, { ok: false, error: 'bad_request' }),
  );
  process.stdin.on('end', () => {
    ended = true;
    onEnd?.();
    settle();
  });
  // Nobody reads the answers any more (the helper or the session ended): what's running finishes.
  process.stdout.on('error', () => {});
  process.stdout.write(`${JSON.stringify({ [ready]: 1 })}\n`);
  settle();
}

export function start(): void {
  // The session ended, or "Lock now": ilex-root too (after what it's doing), never left without it.
  serve('ilex-helper', handle, { onEnd: endRoot });
}
