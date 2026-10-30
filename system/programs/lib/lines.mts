// A stream's text, line by line (shared by the programs and the helper; the app has its own copy).

import { StringDecoder } from 'node:string_decoder';

/**
 * Calls `onLine` with each line (without its line break; a character split between chunks stays
 * whole). A line longer than `maxLength` is never kept: `onTooLong` is told once and the rest of
 * that line is skipped. What's left at the end is the last line.
 */
export function readLines(
  stream: NodeJS.EventEmitter,
  maxLength: number,
  onLine: (line: string) => void,
  onTooLong: () => void = () => {},
): void {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let skipping = false;
  const take = (line: string) => {
    if (skipping) skipping = false;
    else if (line.length > maxLength) onTooLong();
    else onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
  };
  stream.on('data', (chunk: Buffer | string) => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      take(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
    }
    if (buffer.length > maxLength) {
      if (!skipping) onTooLong();
      skipping = true;
      buffer = '';
    }
  });
  stream.on('end', () => {
    buffer += decoder.end();
    if (buffer) take(buffer);
    buffer = '';
  });
}
