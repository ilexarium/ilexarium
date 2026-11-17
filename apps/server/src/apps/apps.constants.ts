/** Files Ilexarium keeps in an app's folder. */
export const ILEX_DIR = '.ilex';
export const TASK_FILE = '.ilex/task.json';
export const TASKS_DIR = '.ilex/tasks';
export const COMPOSE_FILE = 'compose.yml';
/** Other names Compose reads, in its own order (an app made outside Ilexarium may use them). */
export const COMPOSE_FILES = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'docker-compose.yml',
];
export const ENV_FILE = '.env';

/** `@@ilex-result`, then SERVICE_RESULT, EXIT_CODE and EXIT_STATUS: added by systemd at a task's end. */
export const TASK_RESULT_MARKER = '@@ilex-result';

/** What `systemctl is-active` says of a unit that has ended (one that's gone, too: `inactive`). */
export const TASK_ENDED_STATES = ['inactive', 'failed'];

/** Starting a unit, asking about it, a Compose check: the helper's own limit is 30 s. */
export const QUICK_MS = 35_000;
/** Measuring and deleting folders: the helper's own limit is 10 minutes. */
export const LONG_MS = 11 * 60_000;
/** What is shown of a task's log: its end. */
export const TASK_TAIL_BYTES = 64 * 1024;

/** Changes as the person: a few a minute (each may start a unit). */
export const CHANGE_LIMIT = { default: { limit: 20, ttl: 60_000 } };

/** Terminal colours and carriage returns: a task's log is shown as plain lines. */
// oxlint-disable-next-line no-control-regex
export const LOG_CONTROL = /\x1b\[[0-9;?]*[A-Za-z]|\r/g;

/** How an account runs Docker is asked again after this long. */
export const DOCKER_ACCESS_CACHE_MS = 60_000;
