import { LOG_LIMITS, type LogLine, type LogStream } from '@homelab/shared';

const HEADER_BYTES = 8;
const NEWLINE = 0x0a;
/** `2026-10-11T17:59:34.077485265Z ` — what `timestamps=1` puts before every message. */
const TIMESTAMP = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z /;
/** Room for the timestamp prefix on top of the text limit. */
const PREFIX_BYTES = 64;
/**
 * ANSI escape sequences: CSI (`ESC [ … m`, also the 8-bit form), OSC (`ESC ] … BEL`), then any
 * other `ESC`, optional intermediates and a final byte (e.g. the charset switch `ESC ( B`).
 */
const ANSI =
  // oxlint-disable-next-line no-control-regex
  /\x1b\[[0-?]*[ -/]*[@-~]|\x9b[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[ -/]*[0-~]/g;
/** Control characters left after the escapes (keeps tabs). */
// oxlint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0a-\x1f\x7f-\x9f]/g;

/**
 * Turns the body of `GET /containers/{id}/logs?timestamps=1` into lines. Chunks may split it
 * anywhere — mid-header, mid-line, mid-character.
 *
 * - Without a TTY, Docker multiplexes stdout and stderr: each message is a frame with an 8-byte
 *   header (stream type, 3 zero bytes, big-endian length). A message over 16 KB is split into
 *   several frames that don't end in a newline, each with its own timestamp; the parts are joined.
 * - With a TTY (`Config.Tty`), the body is raw text (all stdout), lines ending in `\r\n`.
 *
 * Every line is cut at `LOG_LIMITS.maxLineBytes`, so memory stays bounded whatever arrives.
 * Timestamps are normalised to 9 fraction digits, so they compare correctly as strings.
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
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/.exec(value);
  return match ? `${match[1]}.${(match[2] ?? '').padEnd(9, '0')}Z` : null;
}

/** For Docker's `since`, which takes Unix seconds: `1791741574.315449738`. */
export function toUnixSeconds(timestamp: string): string {
  const normalised = normaliseTimestamp(timestamp);
  if (!normalised) throw new Error(`Not a Docker timestamp: ${timestamp}`);
  const seconds = Date.parse(`${normalised.slice(0, 19)}Z`) / 1000;
  return `${seconds}.${normalised.slice(20, 29)}`;
}

/** Plain text: ANSI escapes and control characters removed. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '').replace(CONTROL, '');
}

/** One line being put together, its bytes capped. */
class PendingLine {
  private readonly parts: Buffer[] = [];
  private size = 0;
  private truncated = false;

  constructor(
    readonly at: string,
    private readonly limit: number,
  ) {}

  /** Bytes were dropped before they got here. */
  markTruncated(): void {
    this.truncated = true;
  }

  append(bytes: Buffer): void {
    const room = this.limit - this.size;
    if (bytes.length > room) this.truncated = true;
    const kept = bytes.subarray(0, Math.max(0, room));
    if (kept.length === 0) return;
    this.parts.push(kept);
    this.size += kept.length;
  }

  toLine(stream: LogStream): LogLine {
    let bytes = Buffer.concat(this.parts, this.size);
    if (this.truncated) bytes = bytes.subarray(0, charBoundary(bytes));
    const text = stripAnsi(bytes.toString('utf8'));
    return { at: this.at, stream, text, ...(this.truncated && { truncated: true }) };
  }
}

/** The length of `bytes` without a UTF-8 character cut off at the end. */
function charBoundary(bytes: Buffer): number {
  // Back up over up to 3 continuation bytes (10xxxxxx) to the last character's lead byte.
  let lead = bytes.length - 1;
  while (lead >= 0 && bytes.length - lead <= 3 && (bytes[lead] & 0xc0) === 0x80) lead--;
  if (lead < 0) return bytes.length;
  const byte = bytes[lead];
  const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
  return lead + length > bytes.length ? lead : bytes.length;
}

/** Splits `bytes` (one message, or a run of raw text) into its timestamp and the rest. */
function splitTimestamp(bytes: Buffer, fallback: string): { at: string; rest: Buffer } {
  const head = bytes.subarray(0, PREFIX_BYTES).toString('latin1');
  const match = TIMESTAMP.exec(head);
  if (!match) return { at: fallback, rest: bytes };
  return {
    at: `${match[1]}.${(match[2] ?? '').padEnd(9, '0')}Z`,
    rest: bytes.subarray(match[0].length),
  };
}

/** Lines without a timestamp of their own (shouldn't happen) get the previous one, or now. */
function now(): string {
  return normaliseTimestamp(new Date().toISOString())!;
}

async function* multiplexedLines(body: AsyncIterable<Buffer>): AsyncGenerator<LogLine> {
  const pending: Record<LogStream, PendingLine | null> = { stdout: null, stderr: null };
  let lastAt: string | null = null;
  let header = Buffer.alloc(0);
  // The current frame: its stream, the bytes still to come, and what's kept of it.
  let stream: LogStream = 'stdout';
  let remaining = 0;
  let frame: Buffer[] = [];
  let frameKept = 0;
  let frameDropped = false;
  const frameLimit = LOG_LIMITS.maxLineBytes + PREFIX_BYTES;

  function* endFrame(): Generator<LogLine> {
    const bytes = Buffer.concat(frame, frameKept);
    const dropped = frameDropped;
    frame = [];
    frameKept = 0;
    frameDropped = false;
    const open = pending[stream];
    // A continuation of a split message repeats the timestamp: drop it, keep the first.
    const { at, rest } = splitTimestamp(bytes, open?.at ?? lastAt ?? now());
    lastAt = at;
    let line = open ?? new PendingLine(at, LOG_LIMITS.maxLineBytes);
    let start = 0;
    for (let i = rest.indexOf(NEWLINE); i !== -1; i = rest.indexOf(NEWLINE, start)) {
      line.append(rest.subarray(start, i));
      yield line.toLine(stream);
      line = new PendingLine(at, LOG_LIMITS.maxLineBytes);
      start = i + 1;
    }
    if (dropped) {
      // Over the frame cap: the rest of this message is lost, so it ends here, cut.
      line.append(rest.subarray(start));
      line.markTruncated();
      yield line.toLine(stream);
      pending[stream] = null;
    } else if (start < rest.length) {
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
        header = Buffer.alloc(0);
        if (remaining === 0) continue;
      }
      const take = Math.min(remaining, chunk.length - offset);
      const keep = Math.min(take, frameLimit - frameKept);
      if (keep < take) frameDropped = true;
      if (keep > 0) {
        frame.push(chunk.subarray(offset, offset + keep));
        frameKept += keep;
      }
      offset += take;
      remaining -= take;
      if (remaining === 0) yield* endFrame();
    }
  }
  if (header.length > 0 || remaining > 0) throw new Error('Docker log stream ended mid-frame');
  for (const name of ['stdout', 'stderr'] as const) {
    const line = pending[name];
    if (line) yield line.toLine(name);
  }
}

async function* ttyLines(body: AsyncIterable<Buffer>): AsyncGenerator<LogLine> {
  // Raw text: the line's bytes so far (capped), and whether more were dropped.
  let parts: Buffer[] = [];
  let kept = 0;
  let dropped = false;
  let lastAt: string | null = null;
  const limit = LOG_LIMITS.maxLineBytes + PREFIX_BYTES;

  const finish = (): LogLine => {
    const bytes = Buffer.concat(parts, kept);
    parts = [];
    kept = 0;
    const { at, rest } = splitTimestamp(bytes, lastAt ?? now());
    lastAt = at;
    const line = new PendingLine(at, LOG_LIMITS.maxLineBytes);
    line.append(rest);
    if (dropped) line.markTruncated();
    dropped = false;
    return line.toLine('stdout');
  };

  for await (const chunk of body) {
    let start = 0;
    for (let i = chunk.indexOf(NEWLINE); i !== -1; i = chunk.indexOf(NEWLINE, start)) {
      append(chunk.subarray(start, i));
      yield finish();
      start = i + 1;
    }
    append(chunk.subarray(start));
  }
  if (kept > 0 || dropped) yield finish();

  function append(bytes: Buffer): void {
    const keep = Math.min(bytes.length, limit - kept);
    if (keep < bytes.length) dropped = true;
    if (keep > 0) {
      parts.push(bytes.subarray(0, keep));
      kept += keep;
    }
  }
}
