import { type PictureTools, squarePicture } from './picture';

/** A canvas that records what was drawn and makes the blob types the "browser" supports. */
function fakeTools(image: { width: number; height: number }, supports: string[]) {
  const calls: unknown[][] = [];
  const context = {
    clearRect: vi.fn(),
    fillRect: vi.fn((...args: unknown[]) => calls.push(['fillRect', ...args])),
    drawImage: vi.fn((...args: unknown[]) => calls.push(['drawImage', ...args.slice(1)])),
    fillStyle: '',
    imageSmoothingQuality: 'low',
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => context,
    toBlob: (done: (blob: Blob | null) => void, type: string, quality: number) => {
      calls.push(['toBlob', type, quality]);
      // A browser that can't make a type makes PNG instead (what toBlob does).
      done(new Blob(['x'], { type: supports.includes(type) ? type : 'image/png' }));
    },
  };
  const close = vi.fn();
  const tools: PictureTools = {
    decode: vi.fn(async () => ({ ...image, close }) as never),
    canvas: () => canvas as unknown as HTMLCanvasElement,
  };
  return { tools, canvas, context, calls, close };
}

describe('squarePicture', () => {
  it('draws the centred square of a wide photo at 600×600, as WebP', async () => {
    const { tools, canvas, calls, close } = fakeTools({ width: 4000, height: 3000 }, [
      'image/webp',
      'image/jpeg',
    ]);
    const picture = await squarePicture(new Blob(['photo']), tools);
    expect(picture.type).toBe('image/webp');
    expect([canvas.width, canvas.height]).toEqual([600, 600]);
    expect(calls).toEqual([
      ['drawImage', 500, 0, 3000, 3000, 0, 0, 600, 600],
      ['toBlob', 'image/webp', 0.85],
    ]);
    expect(close).toHaveBeenCalled();
  });

  it('takes the middle of a tall photo', async () => {
    const { tools, calls } = fakeTools({ width: 1000, height: 1600 }, ['image/webp']);
    await squarePicture(new Blob(['photo']), tools);
    expect(calls[0]).toEqual(['drawImage', 0, 300, 1000, 1000, 0, 0, 600, 600]);
  });

  it('makes JPEG on white where the browser can’t make WebP', async () => {
    const { tools, calls } = fakeTools({ width: 600, height: 600 }, ['image/jpeg']);
    const picture = await squarePicture(new Blob(['photo']), tools);
    expect(picture.type).toBe('image/jpeg');
    expect(calls.map((call) => call[0])).toEqual([
      'drawImage',
      'toBlob',
      'fillRect',
      'drawImage',
      'toBlob',
    ]);
    expect(calls.at(-1)).toEqual(['toBlob', 'image/jpeg', 0.85]);
  });

  it('rejects a file the browser can’t read as an image', async () => {
    const { tools } = fakeTools({ width: 1, height: 1 }, []);
    tools.decode = () => Promise.reject(new DOMException('bad', 'InvalidStateError'));
    await expect(squarePicture(new Blob(['<svg/>']), tools)).rejects.toThrow();
  });

  it('rejects an image without pixels', async () => {
    const { tools, close } = fakeTools({ width: 0, height: 0 }, ['image/webp']);
    await expect(squarePicture(new Blob(['x']), tools)).rejects.toThrow('Not a picture');
    expect(close).toHaveBeenCalled();
  });
});
