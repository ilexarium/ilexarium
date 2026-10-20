import type { Request } from 'express';

/**
 * The request's body, up to `limit` bytes; `tooLarge()` is thrown as soon as it's clear there is
 * more — from `Content-Length` before reading, or while reading — so memory stays bounded.
 */
export async function readBody(
  req: Request,
  limit: number,
  tooLarge: () => Error,
): Promise<Buffer> {
  const length = Number(req.headers['content-length']);
  if (Number.isFinite(length) && length > limit) throw tooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) {
      req.destroy();
      throw tooLarge();
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
