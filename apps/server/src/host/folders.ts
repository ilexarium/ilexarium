import type { ProgramConfig } from '../root-programs/root-programs.model.js';
import { SYSTEM_FOLDERS } from './host.constants.js';

export const inside = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

/** Not a system folder, not the platform's own, neither inside one nor holding one. */
export function notSystem(config: ProgramConfig, path: string): boolean {
  return (
    path !== '/' &&
    !SYSTEM_FOLDERS.some((denied) => inside(path, denied) || inside(denied, path)) &&
    !config.protectedPaths.some((denied) => inside(path, denied) || inside(denied, path))
  );
}
