import type { Readable } from 'node:stream';

/** A file to send to the browser. */
export interface Download {
  name: string;
  size: number;
  stream: Readable;
}
