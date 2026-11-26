import { ROOT_NEVER_MOVED, ROOT_NEVER_MOVED_BELOW } from './files.constants.js';

/** A folder root never renames or moves: the same as ilex-root's removal never deletes. */
export function protectedFolder(path: string): boolean {
  const inside = (root: string) => path === root || path.startsWith(`${root}/`);
  return (
    ROOT_NEVER_MOVED.includes(path) ||
    /^\/home\/[^/]+$/.test(path) ||
    ROOT_NEVER_MOVED_BELOW.some(inside)
  );
}
