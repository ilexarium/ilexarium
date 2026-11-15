import type { Client, ClientChannel } from 'ssh2';
import { readLines } from '../common/read-lines.js';
import {
  HELPER_ANSWER_MAX,
  HELPER_MESSAGE_MAX,
  HELPER_READY,
  HELPER_START_TIMEOUT_MS,
} from './linux-sessions.constants.js';
import type { HelperAnswer, HelperRequest } from './linux-sessions.model.js';

/**
 * The helper of one Linux session (system/programs/ilex-helper.mts): started as the account in a
 * channel of its own (plain pipes, no terminal), for the session's life. One JSON request per
 * line, answers matched by id; `{"event":…}` lines are its own news (ilex-root ended). Lines
 * before its first are the account's login noise, skipped; nothing is sent before it.
 */
export class LinuxHelper {
  private readonly waiting = new Map<number, (answer: HelperAnswer) => void>();
  private nextId = 0;
  private closed = false;

  private constructor(private readonly channel: ClientChannel) {}

  /** Starts it; rejects when it doesn't start (not installed, its modules unsafe, no channel). */
  static start(client: Client, path: string): Promise<LinuxHelper> {
    return new Promise((resolve, reject) => {
      // The path is the server's setting (LINUX_HELPER: a plain absolute path), never a request's.
      client.exec(path, (error, channel) => {
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
        // Answers are short: something this long isn't the helper speaking.
        readLines(
          channel,
          HELPER_ANSWER_MAX,
          (line) => helper.onLine(line),
          () => helper.close(),
        );
        // Unheard, a stream's error would stop the server.
        channel.on('error', () => helper.close());
        channel.stderr.on('error', () => helper.close());
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
    // Its input ended, its 'close' not there yet: it's gone all the same.
    if (!this.channel.writable) {
      this.close();
      return Promise.resolve({ ok: false, error: 'ended' });
    }
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

  /** Called with each event it sends (`sudo.locked`: ilex-root ended on its own). */
  onEvent: (event: string) => void = () => {};

  private onLine: (line: string) => void = () => {};

  private answer(line: string): void {
    let parsed: { id?: unknown } & Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      return;
    }
    if (typeof parsed['event'] === 'string' && parsed.id === undefined) {
      this.onEvent(parsed['event']);
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
    if (answer['ok'] === true) {
      resolve(answer as HelperAnswer);
      return;
    }
    const message = answer['message'];
    resolve({
      ok: false,
      error: typeof answer['error'] === 'string' ? answer['error'] : 'failed',
      // What a program said, for the person (Compose's refusal of a file).
      ...(typeof message === 'string' && { message: message.slice(0, HELPER_MESSAGE_MAX) }),
    });
  }

  private end(): void {
    if (this.closed) return;
    this.closed = true;
    for (const resolve of this.waiting.values()) resolve({ ok: false, error: 'ended' });
    this.waiting.clear();
  }
}
