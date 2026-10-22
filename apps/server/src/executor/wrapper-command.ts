import { PATH, SUDO, WRAPPER_FILES } from './wrapper-command.constants.js';

export type ExecutorMode = 'sudo' | 'direct';
export type WrapperName = keyof typeof WRAPPER_FILES;
export type WrapperAction = 'up' | 'down';
/**
 * The backup wrapper's actions the app may call. Runs are systemd's: `start` has systemd start
 * "Back up now" (`run-requested`); the timers call `run-scheduled`, `check-scheduled`.
 */
export type BackupWrapperAction =
  'configure' | 'init' | 'start' | 'restore' | 'discard' | 'forget' | 'passphrase';
export type DiskWrapperAction = 'mount' | 'unmount';

export interface WrapperCommand {
  file: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * A program and a list of arguments (never a shell string), and a small fixed environment —
 * never the app's own (it holds the database URL). The values never appear here: they go on
 * stdin (`ps` shows arguments to every user). `sudo -n` never asks for a password: a missing
 * sudoers rule fails at once.
 */
export function wrapperCommand(
  mode: ExecutorMode,
  wrapper: WrapperName,
  args: readonly string[],
  configFile = '',
): WrapperCommand {
  const { installed, repo } = WRAPPER_FILES[wrapper];
  if (mode === 'sudo') {
    return { file: SUDO, args: ['-n', installed, ...args], env: { PATH, LANG: 'C.UTF-8' } };
  }
  return {
    file: process.execPath,
    args: [repo, ...args],
    env: { PATH, LANG: 'C.UTF-8', LARIS_WRAPPER_CONFIG: configFile },
  };
}
