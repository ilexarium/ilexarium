import type { ProfilePictureType } from '@homelab/shared';

export interface PictureInfo {
  type: ProfilePictureType;
  width: number;
  height: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * What a picture is, judged by its bytes alone (never a name or a header the browser sent): a
 * PNG, a WebP or a JPEG, and its width and height as the image itself states them. `null` for
 * anything else — SVG, GIF, HTML, a cut file. Reads headers only; the image is never decoded.
 */
export function inspectPicture(bytes: Buffer): PictureInfo | null {
  return png(bytes) ?? webp(bytes) ?? jpeg(bytes);
}

/** The signature, then the IHDR chunk first: width and height, big-endian. */
function png(bytes: Buffer): PictureInfo | null {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { type: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** `RIFF` <size> `WEBP`, then one of three first chunks, each stating the size its own way. */
function webp(bytes: Buffer): PictureInfo | null {
  if (bytes.length < 30) return null;
  if (bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WEBP') {
    return null;
  }
  // The RIFF size counts everything after its own field: a file cut short isn't a picture.
  if (bytes.readUInt32LE(4) + 8 > bytes.length) return null;
  const size = (width: number, height: number): PictureInfo => ({
    type: 'image/webp',
    width,
    height,
  });
  switch (bytes.toString('latin1', 12, 16)) {
    case 'VP8 ': // lossy: a key frame's start code, then 14-bit width and height
      if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
      return size(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff);
    case 'VP8L': {
      // lossless: a signature byte, then width - 1 and height - 1 in 14 bits each
      if (bytes[20] !== 0x2f) return null;
      const bits = bytes.readUInt32LE(21);
      return size((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    case 'VP8X': // extended: the canvas width - 1 and height - 1 in 24 bits each
      return size(bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1);
    default:
      return null;
  }
}

/** Start-of-frame markers (SOF0–SOF15) — but not DHT (C4), JPG (C8) or DAC (CC). */
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/** `FF D8`, then segments up to the first start-of-frame: height and width, big-endian. */
function jpeg(bytes: Buffer): PictureInfo | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1];
    if (marker === 0xff) {
      at++; // fill byte
      continue;
    }
    // Markers without a length: restart markers, TEM; the image ending before a frame is no image.
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      at += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = bytes.readUInt16BE(at + 2);
    if (length < 2 || at + 2 + length > bytes.length) return null;
    if (isStartOfFrame(marker)) {
      if (length < 7) return null;
      return {
        type: 'image/jpeg',
        height: bytes.readUInt16BE(at + 5),
        width: bytes.readUInt16BE(at + 7),
      };
    }
    at += 2 + length;
  }
  return null;
}
