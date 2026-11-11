// lib/startup.mts — runs as root.
//
// Running as root or not, and reading the input (stdin) — bounded.

import { readSync } from 'node:fs';
import { Refusal } from './output.mts';

export const isRoot = process.getuid?.() === 0;

/** Reads stdin, refusing more than `maxBytes` (a bigger input is never read into memory). */
export function readInput(maxBytes: number, refusalCode: string): string {
  const buffer = Buffer.alloc(maxBytes + 1);
  let length = 0;
  for (;;) {
    let read: number;
    try {
      read = readSync(0, buffer, length, buffer.length - length, null);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EAGAIN') continue;
      if (code === 'EOF') break;
      throw error;
    }
    if (read === 0) break;
    length += read;
    if (length > maxBytes) throw new Refusal(refusalCode, 'input too large');
  }
  return buffer.subarray(0, length).toString('utf8');
}
