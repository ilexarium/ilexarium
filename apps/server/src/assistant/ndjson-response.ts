import type { Response } from 'express';
import type { ChatStreamEvent } from '@homelab/shared';

/**
 * Writes JSON lines to a response, the headers first. A write the browser can't take yet waits
 * for it to drain — or for the connection to close, or `stop`: a closed connection must never
 * leave an answer waiting (it holds the person's one answer slot).
 */
export function ndjsonWriter(res: Response, stop: AbortSignal) {
  let started = false;
  return {
    get started(): boolean {
      return started;
    },
    write(event: ChatStreamEvent): Promise<void> {
      if (!started) {
        started = true;
        res.status(200).set({
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          // No proxy buffering: the pieces should arrive as they're written.
          'X-Accel-Buffering': 'no',
        });
        res.flushHeaders();
      }
      if (stop.aborted || res.destroyed) return Promise.resolve();
      if (res.write(`${JSON.stringify(event)}\n`)) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const done = () => {
          res.off('drain', done);
          res.off('close', done);
          stop.removeEventListener('abort', done);
          resolve();
        };
        res.once('drain', done);
        res.once('close', done);
        stop.addEventListener('abort', done, { once: true });
      });
    },
  };
}
