import type { Request } from 'express';

/**
 * The request's body, up to `limit` bytes; rejects with `tooLarge()` as soon as it's clear there is
 * more — from `Content-Length` before reading, or while reading. Past the limit the rest is read
 * and dropped (memory stays bounded), so the connection stays whole for the 413 answer.
 */
export function readBody(req: Request, limit: number, tooLarge: () => Error): Promise<Buffer> {
  const length = Number(req.headers['content-length']);
  if (Number.isFinite(length) && length > limit) {
    req.resume(); // dropped, not read
    return Promise.reject(tooLarge());
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      if (over) return;
      size += chunk.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        reject(tooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!over) resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}
