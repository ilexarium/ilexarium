import type { JobPhase } from '@homelab/shared';

/** The job running now (one at a time), with its live output. */
export interface ActiveJob {
  /** Null while the request is still being checked (the slot is already claimed). */
  id: string | null;
  serviceId: string | null;
  phase: JobPhase | null;
  /** The newest lines, at most 256 KB. */
  lines: string[];
  bytes: number;
  /** Lines dropped from the start to stay within the limit. */
  omitted: number;
}
