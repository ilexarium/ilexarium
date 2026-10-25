import { fileURLToPath } from 'node:url';

export const SUDO = '/usr/bin/sudo';
export const PATH = '/usr/sbin:/usr/bin:/sbin:/bin';

const repo = (file: string) =>
  fileURLToPath(new URL(`../../../../system/wrappers/${file}`, import.meta.url));

/**
 * Each wrapper where the installer puts it (root-owned — the path the sudoers rule names), and in
 * this repository (development and tests, `direct` mode).
 */
export const WRAPPER_FILES = {
  compose: { installed: '/opt/laris/libexec/laris-compose.mts', repo: repo('laris-compose.mts') },
  backup: { installed: '/opt/laris/libexec/laris-backup.mts', repo: repo('laris-backup.mts') },
  disk: { installed: '/opt/laris/libexec/laris-disk.mts', repo: repo('laris-disk.mts') },
} as const;

export type WrapperName = keyof typeof WRAPPER_FILES;
