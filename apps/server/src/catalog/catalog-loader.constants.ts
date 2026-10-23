export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_ICON_BYTES = 64 * 1024;
/** What an icon must not contain, though it is only ever shown through <img> (where nothing runs). */
export const UNSAFE_SVG = /<script|<foreignObject|\son[a-z]+\s*=|href\s*=|url\(|<!ENTITY/i;
