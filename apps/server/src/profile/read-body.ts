import { BadRequestException } from '@nestjs/common';
import type { Request } from 'express';
import getRawBody from 'raw-body';

/**
 * The request's body, up to `limit` bytes (`raw-body`, as Express's own body parser): more —
 * by `Content-Length` before reading, or while reading — rejects with `tooLarge()`; a body that
 * doesn't match its `Content-Length` is a 400.
 */
export async function readBody(
  req: Request,
  limit: number,
  tooLarge: () => Error,
): Promise<Buffer> {
  try {
    return await getRawBody(req, { limit, length: req.headers['content-length'] });
  } catch (error) {
    // raw-body stops reading at the error: the rest is dropped, so the answer still gets through.
    req.resume();
    if ((error as { type?: string }).type === 'entity.too.large') throw tooLarge();
    throw new BadRequestException('The request body was cut short or longer than it said');
  }
}
