/** What the dialog does with the picture when saved. `url`: the preview (an object URL). */
export type PictureChange =
  { kind: 'keep' } | { kind: 'set'; picture: Blob; url: string } | { kind: 'remove' };

/** Why a chosen file can't be used: not a picture the browser can read, or far too large. */
export type PictureProblem = 'unreadable' | 'tooLarge';

/** Draws the picture the profile keeps; see `squarePicture`. Tests provide a fake. */
export type PictureEncoder = (file: Blob) => Promise<Blob>;
