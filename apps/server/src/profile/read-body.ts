import type { Request } from 'express';
import getRawBody from 'raw-body';

/**
 * The request's body, up to `limit` bytes (`raw-body`, as Express's own body parser): more —
 * by `Content-Length` before reading, or while reading — rejects with `tooLarge()`; anything
 * else that stops it being read whole (cut short, aborted, read already) with `unreadable()`.
 */
export async function readBody(
  req: Request,
  limit: number,
  errors: { tooLarge: () => Error; unreadable: () => Error },
): Promise<Buffer> {
  try {
    return await getRawBody(req, { limit, length: req.headers['content-length'] });
  } catch (error) {
    // raw-body stops reading at the error; what's still coming is dropped, so the answer gets through.
    req.resume();
    throw (error as { type?: string }).type === 'entity.too.large'
      ? errors.tooLarge()
      : errors.unreadable();
  }
}
