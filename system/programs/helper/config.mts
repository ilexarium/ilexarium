import { join } from 'node:path';

// Tests start it with `node` and a folder of fake programs; installed, the shebang's `env -i`
// empties the environment, so this is never set.
export const FAKE_BIN = process.env['ILEX_HELPER_FAKE_BIN'];
const program = (path: string) => (FAKE_BIN ? join(FAKE_BIN, path.split('/').pop()!) : path);

export const PROGRAMS = {
  sudo: program('/usr/bin/sudo'),
  kill: program('/usr/bin/kill'),
  systemdRun: program('/usr/bin/systemd-run'),
  systemctl: program('/usr/bin/systemctl'),
  journalctl: program('/usr/bin/journalctl'),
  docker: program('/usr/bin/docker'),
  rm: program('/usr/bin/rm'),
  du: program('/usr/bin/du'),
  id: program('/usr/bin/id'),
  root: program('/opt/ilex/libexec/ilex-root.mts'),
};

/** Run by systemd at a task's end, so its result is in its log (never a shell). */
export const TASK_END = {
  echo: '/usr/bin/echo',
  printenv: '/usr/bin/printenv',
};

/** The root programs it may start through the account's sudo, and their actions. */
export const ROOT_PROGRAMS: Record<string, { path: string; actions: readonly string[] }> = {
  backup: {
    path: program('/opt/ilex/libexec/ilex-backup.mts'),
    actions: [
      'configure',
      'init',
      'start',
      'restore-start',
      'discard',
      'forget',
      'list',
      'passphrase',
      'recover-check',
      'recover-start',
    ],
  },
  disk: {
    path: program('/opt/ilex/libexec/ilex-disk.mts'),
    actions: ['mount', 'unmount'],
  },
  update: {
    path: program('/opt/ilex/libexec/ilex-update.mts'),
    actions: ['start'],
  },
};

export const PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/** One request line; anything longer is refused unread. Room for the largest root program input
 * (ilex-backup's 256 KB plan) even with every character escaped, inside its JSON request. */
export const LINE_MAX = 1024 * 1024;
/** What is kept of a program's output (its first lines say what happened). */
export const OUTPUT_MAX = 16 * 1024;
/** What is read of Compose's filled-in file (`config --format json`): all of it, or nothing. */
export const COMPOSE_CONFIG_MAX = 4 * 1024 * 1024;
/** What a Compose check answers at most (the server reads 256 KB of an answer). */
export const COMPOSE_ANSWER_MAX = 128 * 1024;
/** What is passed on of a program's words (the server keeps 4000 characters of a message). */
export const MESSAGE_MAX = 4000;
/** What Compose reads from an app's folder by itself: its files, their overrides, `.env`. */
export const COMPOSE_READS = [
  'compose.yaml',
  'compose.yml',
  'compose.override.yaml',
  'compose.override.yml',
  'docker-compose.yaml',
  'docker-compose.yml',
  'docker-compose.override.yaml',
  'docker-compose.override.yml',
  '.env',
];
/** The label naming an app's template (`<id>@<version>`). */
export const TEMPLATE_LABEL = 'ilex.template';
/** What is kept of a root program's output: its result line can be longer. */
export const ROOT_OUTPUT_MAX = 48 * 1024;
/** sudo waits a few seconds after a wrong password (PAM's delay). */
export const SUDO_TIMEOUT_MS = 20_000;
/** ilex-root ends this long after its last request (FILES_LIMITS.sudoIdleMinutes in the app). */
export const ROOT_IDLE_MS =
  FAKE_BIN && process.env['ILEX_ROOT_IDLE_MS']
    ? Number(process.env['ILEX_ROOT_IDLE_MS'])
    : 15 * 60_000;
/** What is read of ilex-root's answer lines (a root program's output is the longest). */
export const ROOT_ANSWER_MAX = 256 * 1024;
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
/** The units it starts: ilex-app-<project>-<action>-<time>. */
export const UNIT_PATTERN = /^ilex-app-[a-z0-9][a-z0-9_-]{0,62}-(up|update|down)-\d{8}T\d{6}$/;
export const TASK_ACTIONS = {
  up: ['up', '--detach', '--remove-orphans'],
  update: ['up', '--detach', '--pull', 'always', '--remove-orphans'],
  down: ['down', '--remove-orphans'],
} as const;
export type TaskAction = keyof typeof TASK_ACTIONS;
/** A service unit's name (the app's SYSTEM_SERVICE_NAME_PATTERN): never a leading `-`. */
export const SERVICE_PATTERN = /^(?!-)[A-Za-z0-9:_.\\@-]{1,240}\.service$/;
export const SERVICE_COMMANDS = ['start', 'stop', 'restart'] as const;
/** What is asked of one unit (`systemctl show -p`). */
export const SERVICE_PROPERTIES = [
  'Id',
  'Names',
  'Description',
  'LoadState',
  'ActiveState',
  'SubState',
  'UnitFileState',
  'FragmentPath',
  'MainPID',
  'MemoryCurrent',
  'Result',
  'ExecMainStatus',
  'NRestarts',
  'StateChangeTimestamp',
] as const;
/** A unit file systemd hasn't loaded (never started): no description or state of its own yet. */
export const NOT_LOADED = 'not-loaded';
/** systemctl's lists are one JSON line: all of it, or nothing. */
export const UNITS_OUTPUT_MAX = 4 * 1024 * 1024;
/** What a list answers at most (the server reads 256 KB of an answer). */
export const UNITS_ANSWER_MAX = 200 * 1024;
/** A unit's description or property is cut here. */
export const UNIT_TEXT_MAX = 1024;
/** systemd's own start and stop timeouts are 90 s. */
export const UNIT_CONTROL_TIMEOUT_MS = 100_000;
/** journald's cursor (the app's JOURNAL_CURSOR_PATTERN): opaque, one argument. */
export const CURSOR_PATTERN = /^[A-Za-z0-9=;_-]{1,512}$/;
/** A boot's ID. */
export const BOOT_ID_PATTERN = /^[0-9a-f]{32}$/;
/** Lines in one answer at most (JOURNAL_LIMITS.linesPerRead in the app). */
export const JOURNAL_LINES_MAX = 500;
/** What a journal answer is at most, in bytes (the server reads 256 KB of an answer). */
export const JOURNAL_ANSWER_MAX = 200 * 1024;
/** A message is cut here, in bytes (JOURNAL_LIMITS.maxMessageBytes). */
export const JOURNAL_MESSAGE_MAX = 16 * 1024;
/** One entry of journalctl's output: a longer one is skipped (a message as bytes is 4× longer). */
export const JOURNAL_ENTRY_MAX = 1024 * 1024;
/** What is asked of each entry; journalctl adds its cursor and times. Never the command line. */
export const JOURNAL_FIELDS = ['PRIORITY', '_SYSTEMD_UNIT', 'SYSLOG_IDENTIFIER', '_PID', 'MESSAGE'];
/** Boots listed at most, the newest. */
export const BOOTS_MAX = 500;
/** The groups journald lets read everything (systemd's own and its tmpfiles' ACLs). */
export const JOURNAL_GROUPS = ['systemd-journal', 'adm', 'wheel'];
export const GROUP_FILE = FAKE_BIN ? join(FAKE_BIN, 'group') : '/etc/group';
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
  '/opt/ilex',
  '/proc',
  '/run',
  '/sbin',
  '/sys',
  '/usr',
  '/var/lib/docker',
  '/var/lib/ilex',
];
/** How many paths one request measures or deletes. */
export const PATHS_MAX = 50;

/** What sudo, sudo-rs and kill say (LC_ALL=C). */
export const MESSAGES = {
  wrongPassword:
    /incorrect password|Sorry, try again|incorrect authentication|authentication failed(?!: interaction required)|no password was provided/i,
  notAllowed:
    /not in the sudoers|not allowed to (?:run|execute)|may not run sudo|I'm afraid I can't do that/i,
  notFound: /No such process/i,
  notPermitted: /Operation not permitted/i,
  noSuchVolume: /no such volume/i,
};
