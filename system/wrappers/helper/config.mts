import { join } from 'node:path';

// Tests start it with `node` and a folder of fake programs; installed, the shebang's `env -i`
// empties the environment, so this is never set.
const FAKE_BIN = process.env['LARIS_HELPER_FAKE_BIN'];
const program = (path: string) => (FAKE_BIN ? join(FAKE_BIN, path.split('/').pop()!) : path);

export const PROGRAMS = {
  sudo: program('/usr/bin/sudo'),
  kill: program('/usr/bin/kill'),
  systemdRun: program('/usr/bin/systemd-run'),
  systemctl: program('/usr/bin/systemctl'),
  docker: program('/usr/bin/docker'),
  rm: program('/usr/bin/rm'),
  du: program('/usr/bin/du'),
  id: program('/usr/bin/id'),
};

/** Run by systemd at a task's end, so its result is in its log (never a shell). */
export const TASK_END = {
  echo: '/usr/bin/echo',
  printenv: '/usr/bin/printenv',
};

/** The root programs it may start through the account's sudo, and their actions. */
export const ROOT_PROGRAMS: Record<string, { path: string; actions: readonly string[] }> = {
  backup: {
    path: program('/opt/laris/libexec/laris-backup.mts'),
    actions: [
      'configure',
      'init',
      'start',
      'restore-start',
      'discard',
      'forget',
      'passphrase',
    ],
  },
  disk: {
    path: program('/opt/laris/libexec/laris-disk.mts'),
    actions: ['mount', 'unmount'],
  },
};

export const PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/** One request line; anything longer is refused unread. */
export const LINE_MAX = 64 * 1024;
/** What is kept of a program's output (its first lines say what happened). */
export const OUTPUT_MAX = 16 * 1024;
/** What is kept of a root program's output: its result line can be longer. */
export const ROOT_OUTPUT_MAX = 48 * 1024;
/** sudo waits a few seconds after a wrong password (PAM's delay). */
export const SUDO_TIMEOUT_MS = 20_000;
export const KILL_TIMEOUT_MS = 10_000;
/** Starting a unit, asking for its state, checking a Compose file: quick. */
export const QUICK_TIMEOUT_MS = 30_000;
/** Deleting or measuring a big folder. */
export const LONG_TIMEOUT_MS = 10 * 60_000;
/** A root program: the server says how long (forgetting archives takes a while), at most this. */
export const ROOT_TIMEOUT_MAX_MS = 30 * 60_000;

export const SIGNALS = ['TERM', 'KILL'] as const;
/** Linux's highest PID (`pid_max` at most 2^22). */
export const PID_MAX = 4_194_304;
export const PASSWORD_MAX = 1024;

/** A Compose project's name, as Compose allows it (the app's name). */
export const PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
/** A named volume (Docker's own rule). */
export const VOLUME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
/** The units it starts: laris-app-<project>-<action>-<time>. */
export const UNIT_PATTERN = /^laris-app-[a-z0-9][a-z0-9_-]{0,62}-(up|update|down)-\d{8}T\d{6}$/;
export const TASK_ACTIONS = {
  up: ['up', '--detach', '--remove-orphans'],
  update: ['up', '--detach', '--pull', 'always', '--remove-orphans'],
  down: ['down', '--remove-orphans'],
} as const;
export type TaskAction = keyof typeof TASK_ACTIONS;
/** A path: absolute, plain, one line. */
export const PATH_FORBIDDEN = /[\x00-\x1f\x7f]/;
export const PATH_MAX = 1024;
/** Never deleted, whatever is asked (a slip would be a disaster). */
export const NEVER_REMOVED = [
  '/',
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/home',
  '/lib',
  '/lib32',
  '/lib64',
  '/media',
  '/mnt',
  '/opt',
  '/proc',
  '/root',
  '/run',
  '/sbin',
  '/srv',
  '/sys',
  '/tmp',
  '/usr',
  '/var',
];
/** Never deleted below these either (the system's and Docker's own). */
export const NEVER_REMOVED_BELOW = [
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/lib',
  '/lib32',
  '/lib64',
  '/opt/laris',
  '/proc',
  '/run',
  '/sbin',
  '/sys',
  '/usr',
  '/var/lib/docker',
  '/var/lib/laris',
];
/** How many paths one request measures or deletes. */
export const PATHS_MAX = 50;

/** What sudo, sudo-rs and kill say (LC_ALL=C). */
export const MESSAGES = {
  wrongPassword:
    /incorrect password|Sorry, try again|incorrect authentication|authentication failed(?!: interaction required)|no password was provided/i,
  passwordRequired: /a password is required|interaction required/i,
  notAllowed:
    /not in the sudoers|not allowed to (?:run|execute)|may not run sudo|I'm afraid I can't do that/i,
  notFound: /No such process/i,
  notPermitted: /Operation not permitted/i,
};
