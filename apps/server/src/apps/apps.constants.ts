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
export const BEFORE_UPDATE_FILE = '.laris/before-update.json';
export const COMPOSE_FILE = 'compose.yml';
/** Other names Compose reads, in its own order (an app made outside Laris may use them). */
export const COMPOSE_FILES = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'docker-compose.yml',
];
export const ENV_FILE = '.env';
export const KEPT_FILE = /^(compose|docker-compose)\.ya?ml\.before-template-\d{8}(-\d+)?$/;

/** `@@laris-result`, then SERVICE_RESULT, EXIT_CODE and EXIT_STATUS: added by systemd at a task's end. */
export const TASK_RESULT_MARKER = '@@laris-result';

/** Starting a unit, asking about it, a Compose check: the helper's own limit is 30 s. */
export const QUICK_MS = 35_000;
/** Measuring and deleting folders: the helper's own limit is 10 minutes. */
export const LONG_MS = 11 * 60_000;
/** A task's log read at once (more comes with the next request). */
export const TASK_READ_BYTES = 256 * 1024;

/** Registry lookups ("Show available versions"). */
export const REGISTRY_TIMEOUT_MS = 10_000;
export const REGISTRY_MAX_BYTES = 2 * 1024 * 1024;
export const REGISTRY_PAGES = 5;
export const REGISTRY_CACHE_MS = 10 * 60_000;
export const REGISTRY_CACHE_ENTRIES = 50;
/** How many versions the list shows. */
export const VERSIONS_SHOWN = 30;
/** Docker Hub's names: `nginx` is `library/nginx` on `registry-1.docker.io`. */
export const DOCKER_HUB = 'registry-1.docker.io';
/** Tags that aren't a version to choose: moving, or not released yet. */
export const HIDDEN_TAG =
  /^(latest|nightly|edge|dev|develop|main|master|release|stable|beta|alpha|test|testing|unstable)$|(^|[-.])(rc|beta|alpha|pre|preview|dev|nightly|snapshot|canary|next)[-.]?\d*($|[-.])/i;
/** Architecture-only or build tags (`amd64`, `sha-1a2b3c`, `pr-12`). */
export const NOISE_TAG =
  /^(sha256-|sha-|pr-|amd64|arm64|armv7|arm|i386|ppc64le|s390x|windows)|\.sig$|\.att$|\.sbom$/i;

/** Changes as the person: a few a minute (each may start a unit). */
export const CHANGE_LIMIT = { default: { limit: 20, ttl: 60_000 } };

/** Terminal colours and carriage returns: a task's log is shown as plain lines. */
// oxlint-disable-next-line no-control-regex
export const LOG_CONTROL = /\x1b\[[0-9;?]*[A-Za-z]|\r/g;

/** How an account runs Docker is asked again after this long. */
export const DOCKER_ACCESS_CACHE_MS = 60_000;
