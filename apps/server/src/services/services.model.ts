import type { LiveJob } from '../jobs/live-job.js';

/** The job running now (one at a time), with its live output. */
export interface ActiveJob {
  live: LiveJob;
  /** Null while the request is still being checked (the slot is already claimed). */
  serviceId: string | null;
  /** Frees the shared slot for privileged operations. */
  release: () => void;
}
