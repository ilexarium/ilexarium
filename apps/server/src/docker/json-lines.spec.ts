import { jsonLines } from './json-lines.js';

async function collect(chunks: (string | Buffer)[]): Promise<unknown[]> {
  async function* source() {
    yield* chunks;
  }
  const result: unknown[] = [];
  for await (const value of jsonLines(source())) result.push(value);
  return result;
}

describe('jsonLines', () => {
  it('yields one object per line', async () => {
    expect(await collect(['{"a":1}\n{"a":2}\n'])).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('joins objects split across chunks, and a last line without a newline', async () => {
    expect(await collect(['{"a"', ':1}\n{"b":', '2}'])).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('keeps multi-byte characters split across chunks intact', async () => {
    const bytes = Buffer.from('{"name":"café"}\n');
    const split = bytes.indexOf(0xa9); // inside "é"
    expect(await collect([bytes.subarray(0, split), bytes.subarray(split)])).toEqual([
      { name: 'café' },
    ]);
  });

  it('skips blank lines', async () => {
    expect(await collect(['\n{"a":1}\r\n\n'])).toEqual([{ a: 1 }]);
  });

  it('fails on a line that is far too long', async () => {
    await expect(collect(['{"a":"', 'x'.repeat(2 * 1024 * 1024)])).rejects.toThrow(/too long/);
  });
});
