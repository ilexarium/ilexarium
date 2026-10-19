import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import { ndjsonWriter } from './ndjson-response.js';

/** A response whose buffer is full: every write says "wait for drain". */
function fullResponse() {
  const res = Object.assign(new EventEmitter(), {
    destroyed: false,
    written: [] as string[],
    status: vi.fn(() => res),
    set: vi.fn(() => res),
    flushHeaders: vi.fn(),
    write: vi.fn((chunk: string) => {
      res.written.push(chunk);
      return false;
    }),
  });
  return res;
}

const TEXT = { type: 'text' as const, text: 'Hello' };

describe('ndjsonWriter', () => {
  it('sends the headers once, then one JSON line per event', async () => {
    const res = fullResponse();
    const writer = ndjsonWriter(res as unknown as Response, new AbortController().signal);
    expect(writer.started).toBe(false);
    const writing = writer.write(TEXT);
    res.emit('drain');
    await writing;
    expect(writer.started).toBe(true);
    expect(res.set).toHaveBeenCalledWith(
      expect.objectContaining({ 'Content-Type': 'application/x-ndjson; charset=utf-8' }),
    );
    expect(res.written).toEqual(['{"type":"text","text":"Hello"}\n']);
  });

  it('stops waiting when the browser goes away (no answer hangs on a closed connection)', async () => {
    const res = fullResponse();
    const writing = ndjsonWriter(res as unknown as Response, new AbortController().signal).write(
      TEXT,
    );
    res.emit('close');
    await expect(writing).resolves.toBeUndefined();
    expect(res.listenerCount('drain')).toBe(0);
  });

  it('stops waiting when the answer is stopped', async () => {
    const res = fullResponse();
    const stop = new AbortController();
    const writing = ndjsonWriter(res as unknown as Response, stop.signal).write(TEXT);
    stop.abort();
    await expect(writing).resolves.toBeUndefined();
  });

  it('writes nothing more once stopped', async () => {
    const res = fullResponse();
    const stop = new AbortController();
    const writer = ndjsonWriter(res as unknown as Response, stop.signal);
    stop.abort();
    await writer.write(TEXT);
    expect(res.written).toEqual([]);
  });
});
