import { BadRequestException } from '@nestjs/common';
import type { Request } from 'express';
import { PassThrough } from 'node:stream';
import { readBody } from './read-body.js';

class TooLarge extends Error {}

function request(body: Buffer, length?: number): Request {
  const stream = new PassThrough();
  Object.assign(stream, {
    headers: length === undefined ? {} : { 'content-length': String(length) },
  });
  stream.end(body);
  return stream as unknown as Request;
}

describe('readBody', () => {
  it('reads a body within the limit', async () => {
    const body = Buffer.from('picture');
    expect(await readBody(request(body, body.length), 100, () => new TooLarge())).toEqual(body);
  });

  it('refuses more than the limit, by its length or while reading', async () => {
    const big = Buffer.alloc(200);
    await expect(readBody(request(big, 200), 100, () => new TooLarge())).rejects.toBeInstanceOf(
      TooLarge,
    );
    await expect(readBody(request(big), 100, () => new TooLarge())).rejects.toBeInstanceOf(
      TooLarge,
    );
  });

  it('refuses a body shorter than its length (400)', async () => {
    await expect(
      readBody(request(Buffer.from('cut'), 50), 100, () => new TooLarge()),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
