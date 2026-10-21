import { readFileSync } from 'node:fs';
import { LOG_LIMITS, type LogLine, logLineSchema } from '@laris/shared';
import { logLines, normaliseTimestamp, stripAnsi, toUnixSeconds } from './log-lines.js';

// Real bodies of `GET /containers/{id}/logs?stdout=1&stderr=1&timestamps=1`, captured from
// throwaway containers: one without a TTY (`echo "out one"; echo "err café" >&2;` a 20,000-char
// line; `printf "last no newline"`), one with (`printf "plain line\n\033[31mred café\033[0m\n…"`).
const multiplexed = readFileSync(new URL('testdata/logs-multiplexed.bin', import.meta.url));
const tty = readFileSync(new URL('testdata/logs-tty.bin', import.meta.url));

const MAX = LOG_LIMITS.maxLineBytes;
const AT = '2026-10-11T12:00:00.000000001Z';

async function collect(chunks: Buffer[], options: { tty: boolean }): Promise<LogLine[]> {
  async function* body() {
    yield* chunks;
  }
  const lines: LogLine[] = [];
  for await (const line of logLines(body(), options)) lines.push(line);
  return lines;
}

/** Every split of `bytes` into chunks of `size`. */
function chunked(bytes: Buffer, size: number): Buffer[] {
  const chunks: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.subarray(i, i + size));
  return chunks;
}

/** A multiplexed frame: 1 = stdout, 2 = stderr. */
function frame(type: number, payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload) : payload;
  const header = Buffer.alloc(8);
  header[0] = type;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

const multiplexedLines: LogLine[] = [
  { at: '2026-10-11T17:59:34.314225079Z', stream: 'stdout', text: 'out one' },
  { at: '2026-10-11T17:59:34.314258704Z', stream: 'stderr', text: 'err café' },
  {
    at: '2026-10-11T17:59:34.315449738Z',
    stream: 'stdout',
    text: 'x'.repeat(MAX),
    truncated: true,
  },
  { at: '2026-10-11T17:59:34.340408244Z', stream: 'stdout', text: 'last no newline' },
];

const ttyLines: LogLine[] = [
  { at: '2026-10-11T17:59:34.077485265Z', stream: 'stdout', text: 'plain line' },
  { at: '2026-10-11T17:59:34.077505765Z', stream: 'stdout', text: 'red café' },
  { at: '2026-10-11T17:59:34.108006694Z', stream: 'stdout', text: 'no newline at end' },
];

describe('logLines — multiplexed (no TTY)', () => {
  it('parses a real body: streams, timestamps, a split 20,000-char line, no final newline', async () => {
    const lines = await collect([multiplexed], { tty: false });
    expect(lines).toEqual(multiplexedLines);
    for (const line of lines) expect(logLineSchema.parse(line)).toEqual(line);
  });

  it('gives the same lines however the body is split — mid-header, mid-line, mid-character', async () => {
    for (const size of [1, 2, 3, 5, 7, 8, 9, 13, 100, 4096]) {
      expect(await collect(chunked(multiplexed, size), { tty: false }), `${size}`).toEqual(
        multiplexedLines,
      );
    }
  });

  it('joins a message split into frames, keeping the first timestamp', async () => {
    const later = '2026-10-11T12:00:01.5Z';
    const body = [frame(1, `${AT} first `), frame(1, `${later} part\n`)];
    expect(await collect(body, { tty: false })).toEqual([
      { at: AT, stream: 'stdout', text: 'first part' },
    ]);
  });

  it('keeps an unfinished stdout line open while stderr lines arrive', async () => {
    const body = [frame(1, `${AT} out `), frame(2, `${AT} err\n`), frame(1, `${AT} line\n`)];
    expect(await collect(body, { tty: false })).toEqual([
      { at: AT, stream: 'stderr', text: 'err' },
      { at: AT, stream: 'stdout', text: 'out line' },
    ]);
  });

  it('splits a frame that holds several lines, and skips empty frames', async () => {
    const body = [frame(1, ''), frame(1, `${AT} a\nb\n`)];
    expect(await collect(body, { tty: false })).toEqual([
      { at: AT, stream: 'stdout', text: 'a' },
      { at: AT, stream: 'stdout', text: 'b' },
    ]);
  });

  it('keeps empty lines', async () => {
    expect(await collect([frame(1, `${AT} \n`)], { tty: false })).toEqual([
      { at: AT, stream: 'stdout', text: '' },
    ]);
  });

  it('normalises timestamps to 9 fraction digits', async () => {
    const body = [frame(1, '2026-10-11T12:00:00.5Z a\n'), frame(1, '2026-10-11T12:00:01Z b\n')];
    expect((await collect(body, { tty: false })).map((line) => line.at)).toEqual([
      '2026-10-11T12:00:00.500000000Z',
      '2026-10-11T12:00:01.000000000Z',
    ]);
  });

  it('gives a line without a timestamp the previous one', async () => {
    const body = [frame(1, `${AT} a\n`), frame(1, 'no timestamp\n')];
    expect(await collect(body, { tty: false })).toEqual([
      { at: AT, stream: 'stdout', text: 'a' },
      { at: AT, stream: 'stdout', text: 'no timestamp' },
    ]);
  });

  it('cuts a long line without splitting a character', async () => {
    for (const char of ['é', '€', '😀']) {
      const text = char.repeat(MAX); // 2–4 bytes each: far over the limit
      const [line] = await collect([frame(1, `${AT} ${text}\n`)], { tty: false });
      expect(line.truncated, char).toBe(true);
      expect(Buffer.byteLength(line.text), char).toBeLessThanOrEqual(MAX);
      expect(Buffer.byteLength(line.text), char).toBeGreaterThan(MAX - 4);
      expect(line.text, char).toBe(char.repeat(line.text.length / char.length));
    }
  });

  it('doesn’t mark a line of exactly the limit as cut', async () => {
    const [line] = await collect([frame(1, `${AT} ${'x'.repeat(MAX)}\n`)], { tty: false });
    expect(line.text).toHaveLength(MAX);
    expect(line.truncated).toBeUndefined();
  });

  it('keeps memory bounded for a huge frame, and marks it cut', async () => {
    const huge = frame(1, `${AT} ${'y'.repeat(4 * 1024 * 1024)}`);
    const lines = await collect([...chunked(huge, 64 * 1024), frame(1, `${AT} next\n`)], {
      tty: false,
    });
    expect(lines).toEqual([
      { at: AT, stream: 'stdout', text: 'y'.repeat(MAX), truncated: true },
      { at: AT, stream: 'stdout', text: 'next' },
    ]);
  });

  it('strips ANSI escapes and control characters', async () => {
    const body = [frame(2, `${AT} \x1b[1;31mERROR\x1b[0m\tdisk\x07 full\r\n`)];
    expect(await collect(body, { tty: false })).toEqual([
      { at: AT, stream: 'stderr', text: 'ERROR\tdisk full' },
    ]);
  });

  it('fails on a body that isn’t multiplexed (a TTY container read the wrong way)', async () => {
    await expect(collect([tty], { tty: false })).rejects.toThrow(/not multiplexed/);
  });

  it('fails when the body ends mid-frame', async () => {
    const cut = frame(1, `${AT} abc\n`).subarray(0, 12);
    await expect(collect([cut], { tty: false })).rejects.toThrow(/mid-frame/);
    await expect(collect([multiplexed.subarray(0, 5)], { tty: false })).rejects.toThrow(
      /mid-frame/,
    );
  });
});

describe('byteChunks', () => {
  it('passes bytes through', async () => {
    const lines = await collect([frame(1, `${AT} ok\n`)], { tty: false });
    expect(lines).toEqual([{ at: AT, stream: 'stdout', text: 'ok' }]);
  });

  it('refuses text chunks (a stream with an encoding set) instead of misparsing them', async () => {
    async function* text() {
      yield `${AT} hello\n`;
    }
    const lines = logLines(text(), { tty: true });
    await expect(lines.next()).rejects.toThrow('Docker log stream delivered text, not bytes');
  });
});

describe('logLines — TTY', () => {
  it('parses a real body: CRLF line ends, ANSI colours, no final newline', async () => {
    expect(await collect([tty], { tty: true })).toEqual(ttyLines);
  });

  it('gives the same lines however the body is split', async () => {
    for (const size of [1, 2, 3, 7, 31, 64]) {
      expect(await collect(chunked(tty, size), { tty: true }), `${size}`).toEqual(ttyLines);
    }
  });

  it('cuts a long line, keeping memory bounded', async () => {
    const long = Buffer.from(`${AT} ${'z'.repeat(4 * 1024 * 1024)}\r\n${AT} next\r\n`);
    expect(await collect(chunked(long, 64 * 1024), { tty: true })).toEqual([
      { at: AT, stream: 'stdout', text: 'z'.repeat(MAX), truncated: true },
      { at: AT, stream: 'stdout', text: 'next' },
    ]);
  });

  it('yields nothing for an empty body', async () => {
    expect(await collect([], { tty: true })).toEqual([]);
    expect(await collect([], { tty: false })).toEqual([]);
  });
});

describe('stripAnsi', () => {
  it.each([
    ['\x1b[31mred\x1b[0m', 'red'],
    ['\x1b[38;5;196mcolour\x1b[39m', 'colour'],
    ['\x1b[2K\x1b[1Gprogress', 'progress'],
    ['\x9b31mC1\x9b0m', 'C1'],
    ['\x1b]0;window title\x07text', 'text'],
    ['\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\', 'link'],
    ['\x1b(Bcharset', 'charset'],
    ['\x1b7save\x1b8 restore', 'save restore'], // keeps the letter after `ESC 7`
    ['\x1b]2;title\x9cafter', 'after'], // OSC ended by the 8-bit ST
    ['a\x00b\x08c\x7fd', 'abcd'],
    ['tab\tkept', 'tab\tkept'],
    ['<script>alert(1)</script>', '<script>alert(1)</script>'], // text, rendered as text
  ])('%j → %j', (input, output) => {
    expect(stripAnsi(input)).toBe(output);
  });
});

describe('timestamps', () => {
  it('normalises Docker timestamps to 9 fraction digits', () => {
    expect(normaliseTimestamp('2026-10-11T12:00:00Z')).toBe('2026-10-11T12:00:00.000000000Z');
    expect(normaliseTimestamp('2026-10-11T12:00:00.12Z')).toBe('2026-10-11T12:00:00.120000000Z');
    expect(normaliseTimestamp('2026-10-11T12:00:00.123456789Z')).toBe(
      '2026-10-11T12:00:00.123456789Z',
    );
    expect(normaliseTimestamp('2026-10-11T12:00:00+02:00')).toBeNull();
    expect(normaliseTimestamp('yesterday')).toBeNull();
  });

  it('turns a timestamp into Unix seconds with nanoseconds, for `since`', () => {
    expect(toUnixSeconds('2026-10-11T17:59:34.315449738Z')).toBe('1791741574.315449738');
    expect(toUnixSeconds('1970-01-01T00:00:01Z')).toBe('1.000000000');
    expect(() => toUnixSeconds('yesterday')).toThrow();
  });
});
