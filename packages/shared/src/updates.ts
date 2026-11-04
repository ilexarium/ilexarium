import { z } from 'zod';

/**
 * Laris's own updates (docs/plans/install_and_update.md): the app checks the release folder for a
 * newer signed release; the person updates with one click and their sudo, laris-update does it
 * as its own unit and goes back to the installed version if the new one doesn't come up.
 */

/** x.y.z, as the release scripts, the installer and laris-update write it. */
export const RELEASE_VERSION_PATTERN = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,5})$/;

/** laris-update's steps as its job file names them, then the installer's (install.sh --update). */
export const UPDATE_PHASES = [
  'check',
  'download',
  'unpack',
  'install',
  'checked',
  'saved',
  'stopped',
  'migrated',
  'installed',
  'started',
  'health',
  'rollback',
] as const;
export type UpdatePhase = (typeof UPDATE_PHASES)[number];

export const UPDATE_OUTCOMES = ['updated', 'failed', 'rolled_back', 'rollback_failed'] as const;
export type UpdateOutcome = (typeof UPDATE_OUTCOMES)[number];

/** Why a check found nothing usable: codes only, the web app words them. */
export const UPDATE_CHECK_ERRORS = ['unreachable', 'bad_signature', 'bad_manifest'] as const;
export type UpdateCheckError = (typeof UPDATE_CHECK_ERRORS)[number];

export const releaseSchema = z.object({
  version: z.string().regex(RELEASE_VERSION_PATTERN),
  published: z.string(),
  /** The release's notes as plain text (never rendered as HTML), or null without any. */
  notes: z.string().nullable(),
});
export type Release = z.infer<typeof releaseSchema>;

export const updateJobSchema = z.object({
  id: z.uuid(),
  from: z.string(),
  to: z.string(),
  startedAt: z.string(),
  phase: z.enum(UPDATE_PHASES).nullable(),
  download: z.object({ bytes: z.number(), total: z.number() }).nullable(),
  /** The installer's last lines. */
  output: z.array(z.string()),
  done: z
    .object({
      outcome: z.enum(UPDATE_OUTCOMES),
      /** The version running after it. */
      version: z.string(),
      error: z.string().nullable(),
    })
    .nullable(),
});
export type UpdateJob = z.infer<typeof updateJobSchema>;

/** `GET /api/updates`, and the `updates` topic's value. */
export const updatesStatusSchema = z.object({
  /** Whether this install knows where its updates come from (a release built with RELEASE_URL). */
  configured: z.boolean(),
  installed: z.string(),
  /** The newest signed release seen, when it's newer than the installed one. */
  available: releaseSchema.nullable(),
  /** The newest release's publishing date, whatever its version: a stale folder shows. */
  newestPublished: z.string().nullable(),
  checkedAt: z.string().nullable(),
  checkError: z.enum(UPDATE_CHECK_ERRORS).nullable(),
  checkAutomatically: z.boolean(),
  /** The running update, or the last one's result. */
  job: updateJobSchema.nullable(),
});
export type UpdatesStatus = z.infer<typeof updatesStatusSchema>;

export const updateSettingsSchema = z.strictObject({ checkAutomatically: z.boolean() });
export type UpdateSettings = z.infer<typeof updateSettingsSchema>;

/** `POST /api/updates`: only the version — the release's address is this machine's own setting. */
export const startUpdateSchema = z.strictObject({
  version: z.string().regex(RELEASE_VERSION_PATTERN),
});
export type StartUpdate = z.infer<typeof startUpdateSchema>;

export const startUpdateResponseSchema = z.object({ id: z.uuid() });
export type StartUpdateResponse = z.infer<typeof startUpdateResponseSchema>;

export const UPDATE_ERROR_CODES = {
  notConfigured: 'update_not_configured',
  notAvailable: 'update_not_available',
  busy: 'update_busy',
  unavailable: 'update_unavailable',
} as const;
export type UpdateErrorCode = (typeof UPDATE_ERROR_CODES)[keyof typeof UPDATE_ERROR_CODES];
