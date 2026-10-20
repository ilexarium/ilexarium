import { readFileSync } from 'node:fs';
import { inspectPicture } from './profile-picture.js';

/** Real files: canvas-* made by Chromium's canvas (what the app uploads), the rest by ffmpeg. */
const file = (name: string) => readFileSync(new URL(`./testdata/${name}`, import.meta.url));

describe('inspectPicture', () => {
  it.each([
    ['canvas-600.webp', 'image/webp'], // extended (VP8X), as Chromium makes it
    ['lossy-ffmpeg-600.webp', 'image/webp'], // simple lossy (VP8)
    ['lossless-600.webp', 'image/webp'], // lossless (VP8L)
    ['canvas-600.jpg', 'image/jpeg'],
    ['progressive-600.jpg', 'image/jpeg'],
    ['canvas-600.png', 'image/png'],
  ])('reads %s as %s, 600×600', (name, type) => {
    expect(inspectPicture(file(name))).toEqual({ type, width: 600, height: 600 });
  });

  it('reads the real size of a picture that isn’t square', () => {
    expect(inspectPicture(file('canvas-599x600.webp'))).toEqual({
      type: 'image/webp',
      width: 599,
      height: 600,
    });
  });

  it('judges by the bytes: a JPEG is a JPEG whatever it’s called', () => {
    expect(inspectPicture(file('canvas-600.jpg'))?.type).toBe('image/jpeg');
  });

  it.each([
    ['a GIF', file('red-600.gif')],
    ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"/>')],
    ['HTML', Buffer.from('<!doctype html><script>alert(1)</script>')],
    ['nothing', Buffer.alloc(0)],
    ['a PNG signature alone', file('canvas-600.png').subarray(0, 8)],
    ['a WebP cut short', file('canvas-600.webp').subarray(0, 200)],
    ['a JPEG cut before its frame header', file('canvas-600.jpg').subarray(0, 100)],
    [
      'a RIFF that isn’t WebP',
      Buffer.concat([Buffer.from('RIFF\x20\x00\x00\x00WAVEfmt '), Buffer.alloc(32)]),
    ],
    ['zeros', Buffer.alloc(4096)],
  ])('refuses %s', (_name, bytes) => {
    expect(inspectPicture(bytes)).toBeNull();
  });

  it('refuses a JPEG whose segment lengths run past the end', () => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, 0x00, 0x00]);
    expect(inspectPicture(bytes)).toBeNull();
  });

  it('refuses a JPEG that reaches its image data without a frame header', () => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 0, 0, 0, 0, 0, 0]);
    expect(inspectPicture(bytes)).toBeNull();
  });

  it('reads a PNG’s stated size even when it’s huge (the caller compares it)', () => {
    const png = Buffer.from(file('canvas-600.png'));
    png.writeUInt32BE(100_000, 16);
    expect(inspectPicture(png)).toEqual({ type: 'image/png', width: 100_000, height: 600 });
  });
});
