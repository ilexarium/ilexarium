/** A path's parts resolved (`.`, `..`, doubled slashes), always absolute. */
export function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

/** `name` in `folder`. */
export const joinPath = (folder: string, name: string) => normalizePath(`${folder}/${name}`);

/** Where a rename goes: a plain new name stays in the folder; a path is taken from there (or from /). */
export function renameTarget(folder: string, input: string): string {
  const value = input.trim();
  return value.startsWith('/') ? normalizePath(value) : joinPath(folder, value);
}
