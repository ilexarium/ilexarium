import type { Readable } from 'node:stream';

/** A file to send to the browser. */
export interface Download {
  name: string;
  size: number;
  stream: Readable;
}

/** An image for the preview, its type checked from its bytes. */
export interface PreviewImage {
  type: string;
  stream: Readable;
}
