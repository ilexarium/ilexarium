import { SERVICE_ERROR_CODES, type ServiceErrorCode } from '@laris/shared';

/** Output lines the topic carries per running job. */
export const TOPIC_LINES = 50;

/** Failures where Compose may have created something: a first install is cleaned up after them. */
export const CLEAN_UP_AFTER: readonly ServiceErrorCode[] = [
  SERVICE_ERROR_CODES.composeFailed,
  SERVICE_ERROR_CODES.timedOut,
];

/** Per IP, for installs and removals only (slow and rare); reads aren't limited — pages poll them. */
export const CHANGE_LIMIT = { default: { limit: 10, ttl: 60_000 } };

/** Jobs kept per service. */
export const JOBS_KEPT = 20;

/** Changes come in bursts (every output line): at most one update this often. */
export const SERVICES_PUBLISH_MS = 250;
