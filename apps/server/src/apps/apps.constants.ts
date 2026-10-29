import type { FieldKind } from '@laris/shared';

/** A variable whose name says it's secret (shown masked in the form). */
export const SECRET_NAME = /PASS(WORD|WD)?|SECRET|TOKEN|PRIVATE|CREDENTIAL|(^|_)KEY($|_)|API_?KEY/i;

/** When one variable is used in several places, the more telling kind wins. */
export const KIND_RANK: Record<FieldKind, number> = {
  text: 0,
  secret: 1,
  generated: 2,
  port: 3,
  folder: 3,
  version: 4,
};

/** Files Laris keeps in an app's folder. */
export const LARIS_DIR = '.laris';
export const TASK_FILE = '.laris/task.json';
export const TASKS_DIR = '.laris/tasks';
export const COMPOSE_FILE = 'compose.yml';
/** Other names Compose reads, in its own order (an app made outside Laris may use them). */
export const COMPOSE_FILES = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'docker-compose.yml',
];
export const ENV_FILE = '.env';

/** `@@laris-result`, then SERVICE_RESULT, EXIT_CODE and EXIT_STATUS: added by systemd at a task's end. */
export const TASK_RESULT_MARKER = '@@laris-result';

/** Starting a unit, asking about it, a Compose check: the helper's own limit is 30 s. */
export const QUICK_MS = 35_000;
/** Measuring and deleting folders: the helper's own limit is 10 minutes. */
export const LONG_MS = 11 * 60_000;
/** A task's log read at once (more comes with the next request). */
export const TASK_READ_BYTES = 256 * 1024;

/** Changes as the person: a few a minute (each may start a unit). */
export const CHANGE_LIMIT = { default: { limit: 20, ttl: 60_000 } };

/** Terminal colours and carriage returns: a task's log is shown as plain lines. */
// oxlint-disable-next-line no-control-regex
export const LOG_CONTROL = /\x1b\[[0-9;?]*[A-Za-z]|\r/g;

/** How an account runs Docker is asked again after this long. */
export const DOCKER_ACCESS_CACHE_MS = 60_000;
