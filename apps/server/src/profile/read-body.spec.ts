import type { Request } from 'express';
import { PassThrough } from 'node:stream';
import { readBody } from './read-body.js';

class TooLarge extends Error {}
class Unreadable extends Error {}
const errors = { tooLarge: () => new TooLarge(), unreadable: () => new Unreadable() };

function request(length?: number): PassThrough {
  const headers: Record<string, string> =
    length === undefined ? {} : { 'content-length': String(length) };
  return Object.assign(new PassThrough(), { headers });
}
const asRequest = (stream: PassThrough) => stream as unknown as Request;

describe('readBody', () => {
  it('reads a body within the limit', async () => {
    const body = Buffer.from('picture');
    const req = request(body.length);
    req.end(body);
    expect(await readBody(asRequest(req), 100, errors)).toEqual(body);
  });

  it('refuses more than the limit by its length — and drops the rest, so the answer gets through', async () => {
    const req = request(200);
    const resume = vi.spyOn(req, 'resume');
    req.end(Buffer.alloc(200));
    await expect(readBody(asRequest(req), 100, errors)).rejects.toBeInstanceOf(TooLarge);
    expect(resume).toHaveBeenCalled();
  });

  it('refuses more than the limit while reading, without a length', async () => {
    const req = request();
    req.end(Buffer.alloc(200));
    await expect(readBody(asRequest(req), 100, errors)).rejects.toBeInstanceOf(TooLarge);
  });

  it('calls a body shorter than its length unreadable', async () => {
    const req = request(50);
    req.end(Buffer.from('cut'));
    await expect(readBody(asRequest(req), 100, errors)).rejects.toBeInstanceOf(Unreadable);
  });

  it('calls an upload that breaks off unreadable', async () => {
    const req = request(50);
    const read = readBody(asRequest(req), 100, errors);
    req.write(Buffer.from('part'));
    req.destroy(new Error('aborted'));
    await expect(read).rejects.toBeInstanceOf(Unreadable);
  });
});
