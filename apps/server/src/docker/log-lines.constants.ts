export const HEADER_BYTES = 8;
export const NEWLINE = 0x0a;
const PARTS = String.raw`(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z`;
/** Docker's timestamp alone: the date and time, and up to 9 fraction digits. */
export const TIMESTAMP = new RegExp(`^${PARTS}$`);
/** `2026-10-11T17:59:34.077485265Z ` — what `timestamps=1` puts before every message. */
export const TIMESTAMP_PREFIX = new RegExp(`^${PARTS} `);
/** Room for the timestamp prefix on top of the text limit. */
export const PREFIX_BYTES = 64;
/**
 * ANSI escape sequences: CSI (`ESC [ … m`, also the 8-bit form), OSC (`ESC ] … BEL`, `ESC \` or
 * the 8-bit `ST`), then any other `ESC`, optional intermediates and a final byte (e.g. the
 * charset switch `ESC ( B`, save cursor `ESC 7`). Node's `util.stripVTControlCharacters` was
 * considered: it also removes the character after `ESC 7` / `ESC 8`, losing log text.
 */
export const ANSI =
  // oxlint-disable-next-line no-control-regex
  /\x1b\[[0-?]*[ -/]*[@-~]|\x9b[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)?|\x1b[ -/]*[0-~]/;
/** Control characters left after the escapes (keeps tabs). */
// oxlint-disable-next-line no-control-regex
export const CONTROL = /[\x00-\x08\x0a-\x1f\x7f-\x9f]/;
