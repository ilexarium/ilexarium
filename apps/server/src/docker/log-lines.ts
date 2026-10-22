import { StringDecoder } from 'node:string_decoder';
import { LOG_LIMITS, type LogLine, type LogStream } from '@laris/shared';
import {
  ANSI,
  CONTROL,
  HEADER_BYTES,
  MAX_FRAME_BYTES,
  NEWLINE,
  PREFIX_BYTES,
  TIMESTAMP,
  TIMESTAMP_PREFIX,
} from './log-lines.constants.js';

/**
 * Turns the body of `GET /containers/{id}/logs?timestamps=1` into lines. Chunks may split it
 * anywhere — mid-header, mid-line, mid-character.
 *
 * Without a TTY (most containers), each message is a frame: an 8-byte header, then the message
 * with Docker's timestamp in front.
 *
 *     01 00 00 00 00 00 00 25  2026-10-11T17:59:34.077485265Z hello\n
 *     │           └ length, big-endian: 37 bytes follow
 *     └ 1 stdout, 2 stderr
 *
 * A message over 16 KB comes as several frames of the same stream; only the last ends in `\n`,
 * and each repeats the timestamp. They are joined into one line:
 *
 *     02 … 2026-…Z aaaa…a       (16 KB, no newline)   kept, waits for the rest
 *     01 … 2026-…Z ok\n                               a stdout line in between, as it comes
 *     02 … 2026-…Z aaa\n                              joined: one stderr line, cut and marked
 *
 * With a TTY the body is plain text, stdout only: `2026-…Z hello\r\n`.
 *
 * Every line is cut at `LOG_LIMITS.maxLineBytes` (a container may write a line of any length,
 * without a newline), so memory stays bounded. Timestamps get 9 fraction digits, so they compare
 * correctly as strings.
 */
export function logLines(
  body: AsyncIterable<Buffer | string>,
  { tty }: { tty: boolean },
): AsyncGenerator<LogLine> {
  const bytes = byteChunks(body);
  return tty ? ttyLines(bytes) : multiplexedLines(bytes);
}

/**
 * The body's chunks as raw bytes. A Node stream gives text only once someone sets an encoding,
 * which would break the binary frame headers — refused rather than misparsed.
 */
export async function* byteChunks(body: AsyncIterable<Buffer | string>): AsyncGenerator<Buffer> {
  for await (const chunk of body) {
    if (!Buffer.isBuffer(chunk)) throw new Error('Docker log stream delivered text, not bytes');
    yield chunk;
  }
}

/** Docker's timestamp with exactly 9 fraction digits, or null if it isn't one. */
export function normaliseTimestamp(value: string): string | null {
  const match = TIMESTAMP.exec(value);
  return match && padded(match);
}

/** 9 fraction digits, so timestamps compare correctly as strings. */
function padded([, time, fraction = '']: RegExpExecArray): string {
  return `${time}.${fraction.padEnd(9, '0')}Z`;
}

/** For Docker's `since`, which takes Unix seconds: `1791741574.315449738`. */
export function toUnixSeconds(timestamp: string): string {
  const normalised = normaliseTimestamp(timestamp);
  if (!normalised) throw new Error(`Not a Docker timestamp: ${timestamp}`);
  const seconds = Date.parse(`${normalised.slice(0, 19)}Z`) / 1000;
  return `${seconds}.${normalised.slice(20, 29)}`;
}

// Global copies kept here: a shared `/g` pattern carries `lastIndex` from one caller to the next.
const ANSI_ALL = new RegExp(ANSI, 'g');
const CONTROL_ALL = new RegExp(CONTROL, 'g');

/** Plain text: ANSI escapes and control characters removed. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_ALL, '').replace(CONTROL_ALL, '');
}

/** Bytes collected up to `limit`; what doesn't fit is dropped, and that is remembered. */
class CappedBytes {
  private parts: Buffer[] = [];
  private size = 0;
  private lost = false;

  constructor(private readonly limit: number) {}

  get length(): number {
    return this.size;
  }

  /** Some bytes didn't fit (or were lost before they got here). */
  get dropped(): boolean {
    return this.lost;
  }

  markDropped(): void {
    this.lost = true;
  }

  append(bytes: Buffer): void {
    const kept = bytes.subarray(0, Math.max(0, this.limit - this.size));
    if (kept.length < bytes.length) this.lost = true;
    if (kept.length === 0) return;
    this.parts.push(kept);
    this.size += kept.length;
  }

  /** The bytes so far; it starts empty again. */
  take(): Buffer {
    const bytes = Buffer.concat(this.parts, this.size);
    this.parts = [];
    this.size = 0;
    this.lost = false;
    return bytes;
  }
}

/** One line being put together, its bytes capped. */
class PendingLine {
  private readonly bytes = new CappedBytes(LOG_LIMITS.maxLineBytes);

  constructor(readonly at: string) {}

  /** Bytes were dropped before they got here. */
  markTruncated(): void {
    this.bytes.markDropped();
  }

  append(bytes: Buffer): void {
    this.bytes.append(bytes);
  }

  /** The finished line; this one is used up (start a new one for the next line). */
  finish(stream: LogStream): LogLine {
    const truncated = this.bytes.dropped;
    const bytes = this.bytes.take();
    // Cut at a byte limit: a character cut off at the end is left out, not shown as `�`.
    const text = stripAnsi(
      truncated ? new StringDecoder('utf8').write(bytes) : bytes.toString('utf8'),
    );
    return { at: this.at, stream, text, ...(truncated && { truncated: true }) };
  }
}

/** Splits `bytes` (one message, or a run of raw text) into its timestamp and the rest. */
function splitTimestamp(bytes: Buffer, fallback: string): { at: string; rest: Buffer } {
  const head = bytes.subarray(0, PREFIX_BYTES).toString('latin1');
  const match = TIMESTAMP_PREFIX.exec(head);
  if (!match) return { at: fallback, rest: bytes };
  return { at: padded(match), rest: bytes.subarray(match[0].length) };
}

/** Lines without a timestamp of their own (shouldn't happen) get the previous one, or now. */
function now(): string {
  return normaliseTimestamp(new Date().toISOString())!;
}

async function* multiplexedLines(body: AsyncIterable<Buffer>): AsyncGenerator<LogLine> {
  const pending: Record<LogStream, PendingLine | null> = { stdout: null, stderr: null };
  let lastAt: string | null = null;
  let header = Buffer.alloc(0);
  // The current frame: its stream, the bytes still to come, and those read so far.
  let stream: LogStream = 'stdout';
  let remaining = 0;
  let frame: Buffer[] = [];

  function* endFrame(): Generator<LogLine> {
    const bytes = Buffer.concat(frame);
    frame = [];
    const open = pending[stream];
    // A continuation of a split message repeats the timestamp: drop it, keep the first.
    const { at, rest } = splitTimestamp(bytes, open?.at ?? lastAt ?? now());
    lastAt = at;
    let line = open ?? new PendingLine(at);
    let start = 0;
    for (let i = rest.indexOf(NEWLINE); i !== -1; i = rest.indexOf(NEWLINE, start)) {
      line.append(rest.subarray(start, i));
      yield line.finish(stream);
      line = new PendingLine(at);
      start = i + 1;
    }
    if (start < rest.length) {
      line.append(rest.subarray(start));
      pending[stream] = line;
    } else {
      pending[stream] = null;
    }
  }

  for await (const chunk of body) {
    let offset = 0;
    while (offset < chunk.length) {
      if (remaining === 0 && header.length < HEADER_BYTES) {
        const take = Math.min(HEADER_BYTES - header.length, chunk.length - offset);
        header = Buffer.concat([header, chunk.subarray(offset, offset + take)]);
        offset += take;
        if (header.length < HEADER_BYTES) break;
        if (header[1] !== 0 || header[2] !== 0 || header[3] !== 0 || header[0] > 3) {
          throw new Error('Docker log stream is not multiplexed');
        }
        stream = header[0] === 2 || header[0] === 3 ? 'stderr' : 'stdout';
        remaining = header.readUInt32BE(4);
        if (remaining > MAX_FRAME_BYTES) {
          throw new Error(`Docker log frame of ${remaining} bytes: more than Docker sends`);
        }
        header = Buffer.alloc(0);
        if (remaining === 0) continue;
      }
      const take = Math.min(remaining, chunk.length - offset);
      frame.push(chunk.subarray(offset, offset + take));
      offset += take;
      remaining -= take;
      if (remaining === 0) yield* endFrame();
    }
  }
  if (header.length > 0 || remaining > 0) throw new Error('Docker log stream ended mid-frame');
  for (const name of ['stdout', 'stderr'] as const) {
    const line = pending[name];
    if (line) yield line.finish(name);
  }
}

async function* ttyLines(body: AsyncIterable<Buffer>): AsyncGenerator<LogLine> {
  // Raw text: the line so far, with room for its timestamp prefix.
  const raw = new CappedBytes(LOG_LIMITS.maxLineBytes + PREFIX_BYTES);
  let lastAt: string | null = null;

  const finish = (): LogLine => {
    const dropped = raw.dropped;
    const { at, rest } = splitTimestamp(raw.take(), lastAt ?? now());
    lastAt = at;
    const line = new PendingLine(at);
    line.append(rest);
    if (dropped) line.markTruncated();
    return line.finish('stdout');
  };

  for await (const chunk of body) {
    let start = 0;
    for (let i = chunk.indexOf(NEWLINE); i !== -1; i = chunk.indexOf(NEWLINE, start)) {
      raw.append(chunk.subarray(start, i));
      yield finish();
      start = i + 1;
    }
    raw.append(chunk.subarray(start));
  }
  if (raw.length > 0 || raw.dropped) yield finish();
}
