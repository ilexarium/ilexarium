import { z } from 'zod';

/**
 * Jobs: privileged operations that take a while (installs, removals, restores) — run by the
 * executor, one at a time platform-wide, their progress and output pushed through the realtime
 * topic of their feature. Backup runs are not jobs: their progress comes from the wrapper's
 * progress file, scheduled or manual alike (docs/plans/backups.md, section 5).
 */

export const JOB_KINDS = ['deploy', 'remove', 'restore'] as const;
export const jobKindSchema = z.enum(JOB_KINDS);
export type JobKind = z.infer<typeof jobKindSchema>;

export const JOB_STATUSES = ['running', 'succeeded', 'failed', 'interrupted'] as const;
export const jobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof jobStatusSchema>;

/**
 * What a wrapper announces (`@@phase …`). Deploys: downloading, starting (incl. health),
 * removing. Restores: stopping the service, restoring its folders, starting it again.
 */
export const JOB_PHASES = [
  'pulling',
  'stopping',
  'restoring',
  'starting',
  'removing',
  'done',
] as const;
export const jobPhaseSchema = z.enum(JOB_PHASES);
export type JobPhase = z.infer<typeof jobPhaseSchema>;

export const jobSchema = z.object({
  id: z.uuid(),
  kind: jobKindSchema,
  status: jobStatusSchema,
  /** Null until the wrapper announces one. */
  phase: jobPhaseSchema.nullable(),
  errorCode: z.string().nullable(),
  /** The field a failure is about (e.g. a port that turned out to be taken). */
  errorField: z.string().nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  /** Output lines, oldest first, secrets masked: the last 50 in a topic, all from the job's own route. */
  output: z.array(z.string()),
  /** Lines before `output` that aren't included. */
  omitted: z.number().int().nonnegative(),
});
export type Job = z.infer<typeof jobSchema>;
