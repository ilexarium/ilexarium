import { DOCUMENT, inject, InjectionToken } from '@angular/core';
import { PROFILE_LIMITS } from '@homelab/shared';
import { PICTURE_QUALITY } from './profile-dialog.constants';
import type { PictureEncoder, PictureTools } from './profile-dialog.model';

/** How a chosen file becomes the profile's picture — tests swap in a fake (no canvas in tests). */
export const PICTURE_ENCODER = new InjectionToken<PictureEncoder>('PICTURE_ENCODER', {
  providedIn: 'root',
  factory: () => {
    const document = inject(DOCUMENT);
    return (file) =>
      squarePicture(file, {
        decode: (blob) => createImageBitmap(blob),
        canvas: () => document.createElement('canvas'),
      });
  },
});

/**
 * The centred square of the image, drawn at `pictureSize` × `pictureSize`: WebP, or JPEG where the
 * browser can't make WebP (on white: JPEG has no transparency). Drawing it anew leaves the file's
 * metadata (camera, GPS location) behind; the photo's own rotation is applied while decoding.
 * Rejects if the file isn't an image the browser can read.
 */
export async function squarePicture(file: Blob, tools: PictureTools): Promise<Blob> {
  const image = await tools.decode(file);
  try {
    const side = Math.min(image.width, image.height);
    const size = PROFILE_LIMITS.pictureSize;
    const canvas = tools.canvas();
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    if (!context || side === 0) throw new Error('Not a picture');
    const draw = (background?: string) => {
      context.clearRect(0, 0, size, size);
      if (background) {
        context.fillStyle = background;
        context.fillRect(0, 0, size, size);
      }
      context.imageSmoothingQuality = 'high';
      const x = (image.width - side) / 2;
      const y = (image.height - side) / 2;
      context.drawImage(image, x, y, side, side, 0, 0, size, size);
    };
    draw();
    const webp = await toBlob(canvas, 'image/webp');
    if (webp?.type === 'image/webp') return webp;
    draw('#ffffff');
    const jpeg = await toBlob(canvas, 'image/jpeg');
    if (!jpeg) throw new Error('Could not draw the picture');
    return jpeg;
  } finally {
    image.close?.();
  }
}

function toBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, PICTURE_QUALITY));
}
