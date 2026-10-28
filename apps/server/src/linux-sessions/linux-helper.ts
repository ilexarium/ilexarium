import { StringDecoder } from 'node:string_decoder';
import type { Client, ClientChannel } from 'ssh2';
import {
  HELPER_ANSWER_MAX,
  HELPER_READY,
  HELPER_START_TIMEOUT_MS,
} from './linux-sessions.constants.js';
import type { HelperAnswer, HelperRequest } from './linux-sessions.model.js';

/**
 * The helper of one Linux session (system/wrappers/laris-helper.mts): started as the account in a
 * channel with a terminal — sudo's cache is tied to that terminal, so it lives as long as the
 * session. One JSON request per line, answers matched by id. Lines before its first are the
 * account's login noise, skipped; nothing is sent before it (until then the terminal echoes).
 */
export class LinuxHelper {
  private readonly waiting = new Map<number, (answer: HelperAnswer) => void>();
  private nextId = 0;
  private buffer = '';
  /** Keeps a character split between two chunks whole (a home like /home/jürgen). */
  private readonly decoder = new StringDecoder('utf8');
  private closed = false;

  private constructor(private readonly channel: ClientChannel) {}

  /** Starts it; rejects when it doesn't start (not installed, its modules unsafe, no channel). */
  static start(client: Client, path: string): Promise<LinuxHelper> {
    return new Promise((resolve, reject) => {
      // The path is the server's setting (LINUX_HELPER: a plain absolute path), never a request's.
      client.exec(path, { pty: { term: 'dumb', cols: 200, rows: 24 } }, (error, channel) => {
        if (error) {
          reject(error);
          return;
        }
        const helper = new LinuxHelper(channel);
        let started = false;
        const timeout = setTimeout(() => {
          channel.close();
          reject(new Error('The helper did not start'));
        }, HELPER_START_TIMEOUT_MS);
        helper.onLine = (line) => {
          if (started) {
            helper.answer(line);
            return;
          }
          let first: unknown;
          try {
            first = JSON.parse(line);
          } catch {
            return;
          }
          if ((first as Record<string, unknown> | null)?.[HELPER_READY] !== 1) return;
          clearTimeout(timeout);
          if ((first as { error?: string }).error) {
            channel.close();
            reject(new Error(`The helper refused to start: ${(first as { error: string }).error}`));
            return;
          }
          started = true;
          resolve(helper);
        };
        channel.on('data', (chunk: Buffer) => helper.receive(chunk));
        channel.on('close', () => {
          clearTimeout(timeout);
          helper.end();
          if (!started) reject(new Error('The helper ended before it started'));
        });
      });
    });
  }

  get running(): boolean {
    return !this.closed;
  }

  /** Sends a request; resolves with its answer, or `{ ok: false, error: 'timed_out' | 'ended' }`. */
  request(request: HelperRequest, timeoutMs: number): Promise<HelperAnswer> {
    if (this.closed) return Promise.resolve({ ok: false, error: 'ended' });
    const id = ++this.nextId;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.waiting.delete(id);
        resolve({ ok: false, error: 'timed_out' });
      }, timeoutMs);
      this.waiting.set(id, (answer) => {
        clearTimeout(timeout);
        resolve(answer);
      });
      this.channel.write(`${JSON.stringify({ id, ...request })}\n`);
    });
  }

  close(): void {
    this.channel.close();
    this.end();
  }

  private onLine: (line: string) => void = () => {};

  private receive(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    // The terminal turns "\n" into "\r\n".
    for (let end = this.buffer.indexOf('\n'); end >= 0; end = this.buffer.indexOf('\n')) {
      const line = this.buffer.slice(0, end).replace(/\r$/, '');
      this.buffer = this.buffer.slice(end + 1);
      this.onLine(line);
    }
    // Answers are short: something this long isn't the helper speaking.
    if (this.buffer.length > HELPER_ANSWER_MAX) this.close();
  }

  private answer(line: string): void {
    let parsed: { id?: unknown } & Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      return;
    }
    // A line it couldn't read (it never gets one from here): the channel is garbled, so every
    // waiting request fails now rather than at its timeout.
    if (parsed.id === null) {
      this.close();
      return;
    }
    const resolve = typeof parsed.id === 'number' ? this.waiting.get(parsed.id) : undefined;
    if (!resolve) return;
    this.waiting.delete(parsed.id as number);
    const { id: _, ...answer } = parsed;
    resolve(
      answer['ok'] === true
        ? (answer as HelperAnswer)
        : { ok: false, error: typeof answer['error'] === 'string' ? answer['error'] : 'failed' },
    );
  }

  private end(): void {
    if (this.closed) return;
    this.closed = true;
    for (const resolve of this.waiting.values()) resolve({ ok: false, error: 'ended' });
    this.waiting.clear();
  }
}
