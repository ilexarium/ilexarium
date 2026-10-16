import { fileURLToPath } from 'node:url';

/** Where the installer puts the wrapper (root-owned) — the path the sudoers rule names. */
export const INSTALLED_WRAPPER = '/opt/homelab/libexec/homelab-compose.mts';
/** The wrapper in this repository, for development and tests (`direct` mode). */
export const REPO_WRAPPER = fileURLToPath(
  new URL('../../../../system/wrappers/homelab-compose.mts', import.meta.url),
);
/** The backup wrapper, installed (the sudoers rule names it) and in this repository. */
export const INSTALLED_BACKUP_WRAPPER = '/opt/homelab/libexec/homelab-backup.mts';
export const REPO_BACKUP_WRAPPER = fileURLToPath(
  new URL('../../../../system/wrappers/homelab-backup.mts', import.meta.url),
);
const SUDO = '/usr/bin/sudo';
const PATH = '/usr/sbin:/usr/bin:/sbin:/bin';

export type ExecutorMode = 'sudo' | 'direct';
export type WrapperAction = 'up' | 'down';
/**
 * The backup wrapper's actions the app may call. Runs are systemd's: `start` has systemd start
 * "Back up now" (`run-requested`); the timers call `run-scheduled`, `check-scheduled`.
 */
export type BackupWrapperAction =
  'configure' | 'init' | 'start' | 'restore' | 'discard' | 'forget' | 'passphrase';

export interface WrapperCommand {
  file: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * The exact program, arguments and environment for one wrapper call: a program and a list of
 * arguments (never a shell string), and a small fixed environment — never the app's own (it holds
 * the database URL). The values never appear here: they go on stdin (`ps` shows arguments to every
 * user). `sudo -n` never asks for a password: a missing sudoers rule fails at once.
 */
export function wrapperCommand(
  mode: ExecutorMode,
  action: WrapperAction,
  catalogId: string,
  direct: { wrapper: string; configFile: string } = { wrapper: REPO_WRAPPER, configFile: '' },
): WrapperCommand {
  if (mode === 'sudo') {
    return {
      file: SUDO,
      args: ['-n', INSTALLED_WRAPPER, action, catalogId],
      env: { PATH, LANG: 'C.UTF-8' },
    };
  }
  return {
    file: process.execPath,
    args: [direct.wrapper, action, catalogId],
    env: { PATH, LANG: 'C.UTF-8', HOMELAB_WRAPPER_CONFIG: direct.configFile },
  };
}

/** The same for the backup wrapper: its one argument is the action; everything else on stdin. */
export function backupWrapperCommand(
  mode: ExecutorMode,
  action: BackupWrapperAction,
  direct: { wrapper: string; configFile: string } = {
    wrapper: REPO_BACKUP_WRAPPER,
    configFile: '',
  },
): WrapperCommand {
  if (mode === 'sudo') {
    return {
      file: SUDO,
      args: ['-n', INSTALLED_BACKUP_WRAPPER, action],
      env: { PATH, LANG: 'C.UTF-8' },
    };
  }
  return {
    file: process.execPath,
    args: [direct.wrapper, action],
    env: { PATH, LANG: 'C.UTF-8', HOMELAB_WRAPPER_CONFIG: direct.configFile },
  };
}
