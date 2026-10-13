import { z } from 'zod';
import {
  CATALOG_ID_PATTERN,
  catalogCategorySchema,
  catalogMetaSchema,
  FIELD_KEY_PATTERN,
} from './catalog.js';

/**
 * Installing and removing catalog services: `POST /api/services` (202 + a job), `DELETE
 * /api/services/:id`; progress arrives through the `services` realtime topic. Design:
 * docs/plans/service_deploys.md.
 */

/** Compose project of an installed service: `hl-<catalog id>` (never the platform's own stack). */
export const serviceProject = (catalogId: string) => `hl-${catalogId}`;

const fieldValueSchema = z.union([z.string(), z.number(), z.boolean()]);
const fieldValuesSchema = z.record(z.string().regex(FIELD_KEY_PATTERN), fieldValueSchema);

// Catalog.

export const SERVICE_STATUSES = [
  'installing',
  'installed',
  'failed',
  'removing',
  'removed',
] as const;
export const serviceStatusSchema = z.enum(SERVICE_STATUSES);
export type ServiceStatus = z.infer<typeof serviceStatusSchema>;

/** One card of `GET /api/catalog`. */
export const catalogEntrySummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  category: catalogCategorySchema,
  /** Null if it was never installed. */
  status: serviceStatusSchema.nullable(),
});
export type CatalogEntrySummary = z.infer<typeof catalogEntrySummarySchema>;

/** `GET /api/catalog/:id`: what the install form needs. */
export const catalogEntryDetailsSchema = z.object({
  meta: catalogMetaSchema,
  /** Every image the recipe runs (pinned), for the access summary. */
  images: z.array(z.string()),
  /** The recipe's own named Docker volumes, for the access summary. */
  volumes: z.array(z.string()),
  /** Better starting values than the defaults where the server knows them (a free port, the host's time zone, a previous install's settings). */
  suggested: z.record(z.string(), fieldValueSchema),
  /** Secret fields a previous install already has: left empty, they keep their value. */
  keptSecrets: z.array(z.string()),
  status: serviceStatusSchema.nullable(),
});
export type CatalogEntryDetails = z.infer<typeof catalogEntryDetailsSchema>;

// Requests.

/** `POST /api/services`. The values are checked against the entry's own fields by the server. */
export const deployRequestSchema = z.strictObject({
  catalogId: z.string().regex(CATALOG_ID_PATTERN, 'validation.catalogIdInvalid'),
  values: fieldValuesSchema,
});
export type DeployRequest = z.infer<typeof deployRequestSchema>;

/** Route parameter of `GET /api/catalog/:id` and its icon. */
export const catalogIdParamsSchema = z.strictObject({ id: z.string().regex(CATALOG_ID_PATTERN) });
export type CatalogIdParams = z.infer<typeof catalogIdParamsSchema>;

/** Route parameter of `DELETE /api/services/:id` and `GET /api/services/jobs/:id`. */
export const serviceIdParamsSchema = z.strictObject({ id: z.uuid() });
export type ServiceIdParams = z.infer<typeof serviceIdParamsSchema>;

export const deployResponseSchema = z.object({ serviceId: z.uuid(), jobId: z.uuid() });
export type DeployResponse = z.infer<typeof deployResponseSchema>;

export const removeResponseSchema = z.object({ jobId: z.uuid() });
export type RemoveResponse = z.infer<typeof removeResponseSchema>;

// Jobs.

export const JOB_KINDS = ['deploy', 'remove'] as const;
export const jobKindSchema = z.enum(JOB_KINDS);
export type JobKind = z.infer<typeof jobKindSchema>;

export const JOB_STATUSES = ['running', 'succeeded', 'failed', 'interrupted'] as const;
export const jobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof jobStatusSchema>;

/** What the wrapper announces (`@@phase …`): downloading, starting (incl. health), removing, done. */
export const JOB_PHASES = ['pulling', 'starting', 'removing', 'done'] as const;
export const jobPhaseSchema = z.enum(JOB_PHASES);
export type JobPhase = z.infer<typeof jobPhaseSchema>;

export const SERVICE_ERROR_CODES = {
  catalogEntryNotFound: 'catalog_entry_not_found',
  serviceNotFound: 'service_not_found',
  alreadyInstalled: 'service_already_installed',
  notInstalled: 'service_not_installed',
  /** Another install or removal is running (one at a time, platform-wide). */
  busy: 'busy',
  portInUse: 'port_in_use',
  portReserved: 'port_reserved',
  pathNotAllowed: 'path_not_allowed',
  pathNotFound: 'path_not_found',
  invalidValues: 'invalid_values',
  /** The recipe broke the Compose policy — never expected with reviewed recipes. */
  policyViolation: 'policy_violation',
  /** Compose ran and failed (a pull, a container that didn't get healthy, …): see the output. */
  composeFailed: 'compose_failed',
  /** The server isn't set up for deploys (the sudoers rule or the wrapper is missing). */
  executorUnavailable: 'executor_unavailable',
  /** Took longer than the deploy timeout. */
  timedOut: 'timed_out',
  /** The app restarted while it ran. */
  interrupted: 'interrupted',
  /** The audit log couldn't record the request, so nothing ran (fail closed). */
  auditUnavailable: 'audit_unavailable',
} as const;
export type ServiceErrorCode = (typeof SERVICE_ERROR_CODES)[keyof typeof SERVICE_ERROR_CODES];

export const serviceJobSchema = z.object({
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
  /** Output lines, oldest first, secrets masked: the last 50 in the topic, all in `GET /api/services/jobs/:id`. */
  output: z.array(z.string()),
  /** Lines before `output` that aren't included. */
  omitted: z.number().int().nonnegative(),
});
export type ServiceJob = z.infer<typeof serviceJobSchema>;

// Installed services.

export const installedServiceSchema = z.object({
  id: z.uuid(),
  catalogId: z.string(),
  name: z.string(),
  status: serviceStatusSchema,
  /** The non-secret values it was installed with. */
  settings: z.record(z.string(), fieldValueSchema),
  /** The port of its web page (the "Open" link). */
  webPort: z.number().int().nullable(),
  /** Its latest job, if any. */
  job: serviceJobSchema.nullable(),
  updatedAt: z.iso.datetime(),
});
export type InstalledService = z.infer<typeof installedServiceSchema>;

/** `GET /api/services` and the `services` topic's snapshot and updates. */
export const servicesListSchema = z.object({ services: z.array(installedServiceSchema) });
export type ServicesList = z.infer<typeof servicesListSchema>;
