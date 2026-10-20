/** A chosen file larger than this isn't read at all (a camera photo is a few MB). */
export const SOURCE_MAX_BYTES = 30 * 1024 * 1024;
/** WebP and JPEG quality for the 600×600 picture: about 40–120 KB for a photo. */
export const PICTURE_QUALITY = 0.85;
/** The file picker's choice: what browsers can read (the server takes only its own output). */
export const PICTURE_ACCEPT = 'image/jpeg,image/png,image/webp';
