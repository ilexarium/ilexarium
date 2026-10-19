import type { Response } from 'express';

/**
 * Writes Server-Sent Events to a response, the headers first. A write the browser can't take
 * yet makes {@link drained} wait — for the drain, the connection closing, or `stop`.
 */
export class SseResponse {
  constructor(
    private readonly res: Response,
    private readonly stop: AbortSignal,
  ) {}

  /** Headers and the reconnect delay, sent at once: every outcome after this is an event. */
  start(retryMs: number): void {
    this.res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      // No proxy buffering: events should arrive as they're written.
      'X-Accel-Buffering': 'no',
    });
    this.res.flushHeaders();
    this.write(`retry: ${retryMs}\n\n`);
  }

  /** `data` is JSON (one line); `id` becomes the browser's `Last-Event-ID`. */
  event(name: string, data: unknown, id?: string): void {
    this.write(
      `event: ${name}\n${id === undefined ? '' : `id: ${id}\n`}data: ${JSON.stringify(data)}\n\n`,
    );
  }

  /** A comment, which the browser ignores. */
  comment(): void {
    this.write(':\n\n');
  }

  /** More is buffered than the connection takes: wait for {@link drained} before reading more. */
  get backedUp(): boolean {
    return this.res.writableNeedDrain;
  }

  drained(): Promise<void> {
    if (!this.backedUp || this.stop.aborted || this.res.destroyed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        this.res.off('drain', done);
        this.res.off('close', done);
        this.stop.removeEventListener('abort', done);
        resolve();
      };
      this.res.once('drain', done);
      this.res.once('close', done);
      this.stop.addEventListener('abort', done, { once: true });
    });
  }

  end(): void {
    if (!this.res.writableEnded) this.res.end();
  }

  private write(text: string): void {
    if (!this.res.writableEnded && !this.res.destroyed) this.res.write(text);
  }
}
