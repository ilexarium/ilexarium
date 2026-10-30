// readLines, the programs' copy (lib/lines.mts) and the app's (common/read-lines.ts): the same
// behaviour on both sides. Run by the server's unit tests.
import { EventEmitter } from 'node:events';
import { readLines as appReadLines } from '../../apps/server/src/common/read-lines.ts';
import { readLines as programReadLines } from './lib/lines.mts';

describe.each([
  ['the programs', programReadLines],
  ['the app', appReadLines],
])('readLines (%s)', (_, readLines) => {
  function feed(chunks: (string | Buffer)[], max = 10) {
    const stream = new EventEmitter();
    const lines: string[] = [];
    let tooLong = 0;
    readLines(
      stream,
      max,
      (line) => lines.push(line),
      () => tooLong++,
    );
    for (const chunk of chunks) stream.emit('data', chunk);
    stream.emit('end');
    return { lines, tooLong };
  }

  it('splits lines across chunks, drops a \\r before the break, keeps the last line', () => {
    expect(feed(['a\nb', 'c\r\n', 'd'])).toEqual({ lines: ['a', 'bc', 'd'], tooLong: 0 });
  });

  it('keeps a character split between two chunks whole', () => {
    const bytes = Buffer.from('jürgen\n');
    const at = bytes.indexOf(0xc3) + 1;
    expect(feed([bytes.subarray(0, at), bytes.subarray(at)]).lines).toEqual(['jürgen']);
  });

  it('a whole line too long: told, skipped, the next one read', () => {
    expect(feed(['ok\n0123456789X\nnext\n'])).toEqual({ lines: ['ok', 'next'], tooLong: 1 });
  });

  it('a line growing too long over chunks: told once, its rest skipped', () => {
    expect(feed(['0123456789', 'ABCDEFGHIJ', 'KL\nnext\n'])).toEqual({
      lines: ['next'],
      tooLong: 1,
    });
  });
});
