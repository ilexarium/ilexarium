import { z } from 'zod';
import { existingPasswordSchema } from './auth.js';
import { FIELD_KEY_PATTERN, isPlainAbsolutePath } from './catalog.js';
import { jobSchema } from './jobs.js';

/**
 * Automated backups: daily, encrypted, deduplicated Borg backups of the platform, installed
 * services and chosen folders, to one disk under `/mnt` or `/media`. Runs happen in a root wrapper
 * (started by a systemd timer, or "Back up now" through the executor); the app reads their results
 * and live progress from the wrapper's files and pushes them through the `backups` topic.
 * Design: docs/plans/backups.md.
 */

export const BACKUP_LIMITS = {
  retentionDailyMin: 1,
  retentionDailyMax: 365,
  retentionWeeklyMax: 104,
  retentionMonthlyMax: 120,
  maxItems: 100,
  /** No successful backup for longer than this: a warning across the app. */
  staleAfterHours: 48,
  /** Words of the generated passphrase (EFF large word list: ~77 bits). */
  passphraseWords: 6,
  /** Live output lines kept in the topic. */
  progressLines: 50,
} as const;

/** Where backup disks are mounted; nothing else is a destination. */
export const BACKUP_DESTINATION_ROOTS = ['/mnt', '/media'] as const;
/** The repository's folder on the chosen disk: `<mount point>/homelab-backups`. */
export const BACKUP_REPOSITORY_FOLDER = 'homelab-backups';
/** Disk formats a repository may be on. */
export const BACKUP_FILESYSTEMS = ['ext4', 'btrfs', 'xfs', 'exfat'] as const;

/**
 * A mount point under `/mnt` or `/media` in its plain form (never the roots themselves). That it
 * really is a mount point, of a supported format, is the server's and the wrapper's check.
 */
export function isBackupDestinationPath(path: string): boolean {
  return (
    isPlainAbsolutePath(path) &&
    BACKUP_DESTINATION_ROOTS.some((root) => path.startsWith(`${root}/`))
  );
}

// Schedule and retention.

/** Daily at `time`, or every 12 or 6 hours counting from `time`. */
export const BACKUP_FREQUENCIES = ['daily', 'every12h', 'every6h'] as const;
export const backupFrequencySchema = z.enum(BACKUP_FREQUENCIES);
export type BackupFrequency = z.infer<typeof backupFrequencySchema>;

/** "HH:MM", 24 hours, the server's local time. */
export const BACKUP_TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export const backupScheduleSchema = z.strictObject({
  frequency: backupFrequencySchema,
  time: z.string().regex(BACKUP_TIME_PATTERN, 'validation.backupTimeInvalid'),
});
export type BackupSchedule = z.infer<typeof backupScheduleSchema>;

const keep = (min: number, max: number, range: string) =>
  z
    .number('validation.backupKeepInvalid')
    .int('validation.backupKeepInvalid')
    .min(min, range)
    .max(max, range);

/** How many backups are kept, per item: the last of each day, week and month. */
export const backupRetentionSchema = z.strictObject({
  daily: keep(
    BACKUP_LIMITS.retentionDailyMin,
    BACKUP_LIMITS.retentionDailyMax,
    'validation.backupKeepDailyRange',
  ),
  weekly: keep(0, BACKUP_LIMITS.retentionWeeklyMax, 'validation.backupKeepWeeklyRange'),
  monthly: keep(0, BACKUP_LIMITS.retentionMonthlyMax, 'validation.backupKeepMonthlyRange'),
});
export type BackupRetention = z.infer<typeof backupRetentionSchema>;

export const DEFAULT_BACKUP_SCHEDULE: BackupSchedule = { frequency: 'daily', time: '03:00' };
export const DEFAULT_BACKUP_RETENTION: BackupRetention = { daily: 7, weekly: 4, monthly: 6 };

// Destinations.

/** One mounted disk the user may choose (`GET /api/backups/destinations`). */
export const backupDestinationSchema = z.object({
  mountPoint: z.string(),
  filesystem: z.string(),
  /** A format a repository may be on (`BACKUP_FILESYSTEMS`). */
  supported: z.boolean(),
  totalBytes: z.number().nonnegative(),
  freeBytes: z.number().nonnegative(),
  /** The same disk as data being backed up: allowed, with a warning (a dead disk takes both). */
  sameDiskAsData: z.boolean(),
  /** A repository of ours already there (e.g. after reinstalling the platform). */
  hasRepository: z.boolean(),
});
export type BackupDestination = z.infer<typeof backupDestinationSchema>;

export const backupDestinationsResponseSchema = z.object({
  destinations: z.array(backupDestinationSchema),
});
export type BackupDestinationsResponse = z.infer<typeof backupDestinationsResponseSchema>;

// Items.

export const BACKUP_ITEM_KINDS = ['platform', 'service', 'folder'] as const;
export const backupItemKindSchema = z.enum(BACKUP_ITEM_KINDS);
export type BackupItemKind = z.infer<typeof backupItemKindSchema>;

export const BACKUP_STATUSES = ['ok', 'warning', 'failed'] as const;
export const backupStatusSchema = z.enum(BACKUP_STATUSES);
export type BackupStatus = z.infer<typeof backupStatusSchema>;

/** Why an item, a run or a check failed — the web app words them. */
export const BACKUP_ERROR_CODES = {
  /** The disk isn't mounted, or isn't the one chosen. Nothing was written. */
  destinationUnavailable: 'destination_unavailable',
  /** The repository there isn't ours (another id) or is missing. Nothing was written. */
  repositoryMismatch: 'repository_mismatch',
  /** The passphrase file is missing or doesn't open the repository (a setup problem). */
  passphraseInvalid: 'passphrase_invalid',
  diskFull: 'disk_full',
  sourceMissing: 'source_missing',
  /** A `stop` service couldn't be stopped: it wasn't backed up (and was started again). */
  serviceNotStopped: 'service_not_stopped',
  /** A `stop` service wasn't running again afterwards — the most serious. */
  serviceNotRestarted: 'service_not_restarted',
  /** The platform's database dump failed. */
  dumpFailed: 'dump_failed',
  /** Another operation (an install, a restore) held the lock too long. */
  busy: 'busy',
  /** `borg check` found damage. */
  repositoryDamaged: 'repository_damaged',
  /** Borg failed otherwise: see the output. */
  borgFailed: 'borg_failed',
  /** The run ended without finishing (a crash, a power cut). */
  interrupted: 'interrupted',
  timedOut: 'timed_out',
  executorUnavailable: 'executor_unavailable',
  auditUnavailable: 'audit_unavailable',
  // Requests.
  notConfigured: 'backups_not_configured',
  alreadyConfigured: 'backups_already_configured',
  itemNotFound: 'backup_item_not_found',
  itemExists: 'backup_item_exists',
  /** The platform item is always backed up. */
  itemFixed: 'backup_item_fixed',
  archiveNotFound: 'backup_archive_not_found',
  restoreNotFound: 'backup_restore_not_found',
  pathNotAllowed: 'path_not_allowed',
  pathNotFound: 'path_not_found',
  /** Setting up on a disk that already has a `homelab-backups` folder that isn't ours. */
  repositoryExists: 'repository_exists',
  /** Restoring in place, but the service uses other folders now: restore to a new folder. */
  pathsChanged: 'paths_changed',
  /** The backup wrapper refused the plan (its own checks) — nothing was changed. */
  invalidPlan: 'invalid_plan',
  /** An item's backups can't be deleted while a restore keeps a previous version of it. */
  setAsideKept: 'backup_set_aside_kept',
  /** The service has no backup section in its recipe. */
  serviceNotBackedUp: 'service_not_backed_up',
  destinationNotAllowed: 'destination_not_allowed',
} as const;
export type BackupErrorCode = (typeof BACKUP_ERROR_CODES)[keyof typeof BACKUP_ERROR_CODES];

/** One kept backup of an item — a Borg archive named `<itemId>-<time>`. */
export const backupArchiveSchema = z.object({
  name: z.string(),
  createdAt: z.iso.datetime(),
});
export type BackupArchive = z.infer<typeof backupArchiveSchema>;

/** An item's part of a run. Sizes are Borg's "this archive" figures, in bytes. */
export const backupItemResultSchema = z.object({
  itemId: z.uuid(),
  status: backupStatusSchema,
  errorCode: z.string().nullable(),
  archive: z.string().nullable(),
  originalBytes: z.number().nonnegative().nullable(),
  /** What this archive added to the disk after compression and deduplication. */
  addedBytes: z.number().nonnegative().nullable(),
  /** Borg's warnings (files changed while read, unreadable files), shortened. */
  warnings: z.array(z.string()),
});
export type BackupItemResult = z.infer<typeof backupItemResultSchema>;

export const backupItemSchema = z.object({
  id: z.uuid(),
  kind: backupItemKindSchema,
  /** `service`: the installed service and its catalog entry (the name comes from there). */
  serviceId: z.uuid().nullable(),
  catalogId: z.string().nullable(),
  /** `folder`: the folder. */
  path: z.string().nullable(),
  /** `service`: folder fields switched off by the user. */
  excludedFields: z.array(z.string()),
  /** Removed from the plan: no longer backed up, its archives kept until deleted. */
  removed: z.boolean(),
  lastSuccessAt: z.iso.datetime().nullable(),
  /** Its part of the latest run that included it. */
  lastResult: backupItemResultSchema.nullable(),
});
export type BackupItem = z.infer<typeof backupItemSchema>;

// The plan.

export const backupPlanSchema = z.object({
  /** The chosen disk's mount point; the repository is `<mountPoint>/homelab-backups`. */
  destination: z.string(),
  schedule: backupScheduleSchema,
  retention: backupRetentionSchema,
  /** The disk now; null when it isn't mounted. */
  destinationStatus: backupDestinationSchema.nullable(),
  items: z.array(backupItemSchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type BackupPlan = z.infer<typeof backupPlanSchema>;

/** `GET /api/backups/plan`: null until set up. */
export const backupPlanResponseSchema = z.object({ plan: backupPlanSchema.nullable() });
export type BackupPlanResponse = z.infer<typeof backupPlanResponseSchema>;

// Requests.

/**
 * A disk's mount point. That it's one of the mounted disks under /mnt or /media (the server's
 * list, which development points at pretend disks) is the server's check, and the wrapper's.
 */
const destinationSchema = z
  .string()
  .min(1, 'validation.backupDestinationRequired')
  .refine(isPlainAbsolutePath, 'validation.backupDestinationInvalid');

/** A folder to back up: where it may be (storage roots, home folders) is the server's check. */
const folderPathSchema = z
  .string()
  .min(1, 'validation.pathRequired')
  .refine(isPlainAbsolutePath, 'validation.pathInvalid');

export const backupItemRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('service'),
    serviceId: z.uuid(),
    excludedFields: z.array(z.string().regex(FIELD_KEY_PATTERN)).max(20).optional(),
  }),
  z.strictObject({ kind: z.literal('folder'), path: folderPathSchema }),
]);
export type BackupItemRequest = z.infer<typeof backupItemRequestSchema>;

/** `POST /api/backups/items`: one more service or folder. */
export const backupItemAddRequestSchema = z.strictObject({ item: backupItemRequestSchema });
export type BackupItemAddRequest = z.infer<typeof backupItemAddRequestSchema>;

/**
 * `POST /api/backups/plan`: set up once — creates the repository (and its passphrase) on the
 * disk, writes the plan for the timer. The platform item is always added.
 */
export const backupSetupRequestSchema = z.strictObject({
  destination: destinationSchema,
  schedule: backupScheduleSchema,
  retention: backupRetentionSchema,
  items: z.array(backupItemRequestSchema).max(BACKUP_LIMITS.maxItems),
});
export type BackupSetupRequest = z.infer<typeof backupSetupRequestSchema>;

/**
 * The passphrase, shown once at setup ("I've saved it") and again only with the app password.
 * Never stored by the app, never in logs or job output.
 */
export const backupPassphraseResponseSchema = z.object({ passphrase: z.string() });
export type BackupPassphraseResponse = z.infer<typeof backupPassphraseResponseSchema>;

/** The setup and settings forms (the browser's): disk, schedule and retention, all required. */
export const backupSettingsFormSchema = z.strictObject({
  destination: destinationSchema,
  schedule: backupScheduleSchema,
  retention: backupRetentionSchema,
});
export type BackupSettingsForm = z.infer<typeof backupSettingsFormSchema>;

/** `PUT /api/backups/plan`: change the schedule, the retention or the disk (all optional). */
export const backupPlanUpdateSchema = z.strictObject({
  destination: destinationSchema.optional(),
  schedule: backupScheduleSchema.optional(),
  retention: backupRetentionSchema.optional(),
});
export type BackupPlanUpdate = z.infer<typeof backupPlanUpdateSchema>;

/** `PATCH /api/backups/items/:id`: a service item's folders switched off. */
export const backupItemUpdateSchema = z.strictObject({
  excludedFields: z.array(z.string().regex(FIELD_KEY_PATTERN)).max(20),
});
export type BackupItemUpdate = z.infer<typeof backupItemUpdateSchema>;

/** `POST /api/backups/runs`: "Back up now" — everything, or one item. */
export const backupRunRequestSchema = z.strictObject({ itemId: z.uuid().optional() });
export type BackupRunRequest = z.infer<typeof backupRunRequestSchema>;

/** `POST /api/backups/passphrase`: "Show again" needs the app password. */
export const backupPassphraseRequestSchema = z.strictObject({ password: existingPasswordSchema });
export type BackupPassphraseRequest = z.infer<typeof backupPassphraseRequestSchema>;

/**
 * `POST /api/backups/restores`. `inPlace` (services only): the current folders are set aside as
 * `<folder>.before-restore-<date>` first. `newFolder`: into `/srv/homelab/restores/<item>-<date>/`.
 * A removed service is installed again with its previous settings first.
 */
export const BACKUP_RESTORE_TARGETS = ['inPlace', 'newFolder'] as const;
export const backupRestoreTargetSchema = z.enum(BACKUP_RESTORE_TARGETS);
export type BackupRestoreTarget = z.infer<typeof backupRestoreTargetSchema>;

/** Archive names as the wrapper makes them: `<item uuid>-<YYYY-MM-DDTHH:MM:SS>`. */
export const BACKUP_ARCHIVE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

export const backupRestoreRequestSchema = z.strictObject({
  itemId: z.uuid(),
  archive: z.string().regex(BACKUP_ARCHIVE_PATTERN),
  target: backupRestoreTargetSchema,
});
export type BackupRestoreRequest = z.infer<typeof backupRestoreRequestSchema>;

export const backupItemIdParamsSchema = z.strictObject({ id: z.uuid() });
export type BackupItemIdParams = z.infer<typeof backupItemIdParamsSchema>;

/** `DELETE /api/backups/items/:id?archives=delete`: also delete its archives (confirmed). */
export const backupItemDeleteQuerySchema = z.strictObject({
  archives: z.enum(['keep', 'delete']).default('keep'),
});
export type BackupItemDeleteQuery = z.infer<typeof backupItemDeleteQuerySchema>;

// Responses.

export const backupArchivesResponseSchema = z.object({ archives: z.array(backupArchiveSchema) });
export type BackupArchivesResponse = z.infer<typeof backupArchivesResponseSchema>;

export const backupRunStartedResponseSchema = z.object({ runId: z.uuid() });
export type BackupRunStartedResponse = z.infer<typeof backupRunStartedResponseSchema>;

export const backupRestoreStartedResponseSchema = z.object({
  restoreId: z.uuid(),
  jobId: z.uuid(),
});
export type BackupRestoreStartedResponse = z.infer<typeof backupRestoreStartedResponseSchema>;

// Runs.

export const BACKUP_TRIGGERS = ['scheduled', 'manual'] as const;
export const backupTriggerSchema = z.enum(BACKUP_TRIGGERS);
export type BackupTrigger = z.infer<typeof backupTriggerSchema>;

export const BACKUP_RUN_STATUSES = ['running', ...BACKUP_STATUSES] as const;
export const backupRunStatusSchema = z.enum(BACKUP_RUN_STATUSES);
export type BackupRunStatus = z.infer<typeof backupRunStatusSchema>;

/** One finished run in the history (`GET /api/backups/runs`). */
export const backupRunSchema = z.object({
  id: z.uuid(),
  trigger: backupTriggerSchema,
  /** One item ("Back up now" on it), or null for all. */
  itemId: z.uuid().nullable(),
  status: backupRunStatusSchema,
  errorCode: z.string().nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  items: z.array(backupItemResultSchema),
});
export type BackupRun = z.infer<typeof backupRunSchema>;

export const backupRunsResponseSchema = z.object({ runs: z.array(backupRunSchema) });
export type BackupRunsResponse = z.infer<typeof backupRunsResponseSchema>;

/** `GET /api/backups/runs/:id/output`: the end of a run's output (no secrets ever in it). */
export const backupRunOutputResponseSchema = z.object({
  output: z.array(z.string()),
  omitted: z.number().int().nonnegative(),
});
export type BackupRunOutputResponse = z.infer<typeof backupRunOutputResponseSchema>;

/** What a running item is doing, as the wrapper reports it. */
export const BACKUP_PHASES = ['dumping', 'stopping', 'archiving', 'starting', 'pruning'] as const;
export const backupPhaseSchema = z.enum(BACKUP_PHASES);
export type BackupPhase = z.infer<typeof backupPhaseSchema>;

/** The run in progress, scheduled or manual, read from the wrapper's progress file. */
export const backupProgressSchema = z.object({
  runId: z.uuid(),
  trigger: backupTriggerSchema,
  startedAt: z.iso.datetime(),
  /** In run order; done ones carry their result. */
  items: z.array(
    z.object({
      itemId: z.uuid(),
      state: z.enum(['waiting', 'running', 'done']),
      phase: backupPhaseSchema.nullable(),
      result: backupItemResultSchema.nullable(),
    }),
  ),
  /** The latest output lines (`BACKUP_LIMITS.progressLines`). */
  output: z.array(z.string()),
});
export type BackupProgress = z.infer<typeof backupProgressSchema>;

// Restores.

export const backupRestoreSchema = z.object({
  id: z.uuid(),
  itemId: z.uuid(),
  archive: z.string(),
  target: backupRestoreTargetSchema,
  /** `newFolder`: where it went. */
  targetPath: z.string().nullable(),
  /** `inPlace`: the folders set aside — the way back, until "Delete previous version". */
  setAside: z.array(z.string()),
  setAsideDeleted: z.boolean(),
  job: jobSchema,
});
export type BackupRestore = z.infer<typeof backupRestoreSchema>;

export const backupRestoreIdParamsSchema = z.strictObject({ id: z.uuid() });
export type BackupRestoreIdParams = z.infer<typeof backupRestoreIdParamsSchema>;

export const backupRunIdParamsSchema = z.strictObject({ id: z.uuid() });
export type BackupRunIdParams = z.infer<typeof backupRunIdParamsSchema>;

/** `GET /api/backups/restores`: the latest restores, newest first. */
export const backupRestoresResponseSchema = z.object({ restores: z.array(backupRestoreSchema) });
export type BackupRestoresResponse = z.infer<typeof backupRestoresResponseSchema>;

// The folder picker.

/** `GET /api/backups/folders?path=`: without a path, the places folders may be chosen from. */
export const backupFoldersQuerySchema = z.strictObject({
  path: z.string().refine(isPlainAbsolutePath, 'validation.pathInvalid').optional(),
});
export type BackupFoldersQuery = z.infer<typeof backupFoldersQuerySchema>;

export const backupFoldersResponseSchema = z.object({
  /** Null for the starting places. */
  path: z.string().nullable(),
  /** Where "up" goes: null at a starting place. */
  parent: z.string().nullable(),
  /** False when the app may not look inside (another user's home): the path can still be added. */
  readable: z.boolean(),
  folders: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      /** May be backed up (inside the storage folders or a home folder, not a system folder). */
      allowed: z.boolean(),
    }),
  ),
});
export type BackupFoldersResponse = z.infer<typeof backupFoldersResponseSchema>;

// The `backups` topic.

/** Problems shown across the app (the dashboard, a badge on "Backups"), most serious first. */
export const BACKUP_WARNINGS = [
  'serviceNotRestarted',
  'repositoryDamaged',
  'lastRunFailed',
  'noRecentBackup',
  'destinationUnavailable',
  'lowSpace',
] as const;
export const backupWarningSchema = z.enum(BACKUP_WARNINGS);
export type BackupWarning = z.infer<typeof backupWarningSchema>;

/** The `backups` topic's snapshot and updates: enough for the badge, the dashboard and the cards. */
export const backupsStatusSchema = z.object({
  configured: z.boolean(),
  warnings: z.array(backupWarningSchema),
  lastSuccessAt: z.iso.datetime().nullable(),
  nextRunAt: z.iso.datetime().nullable(),
  /** A run in progress, or null. */
  running: backupProgressSchema.nullable(),
  /** The latest run, or null. */
  lastRun: backupRunSchema.nullable(),
  /** Each active item's latest outcome, for "Backed up · last night" on service cards. */
  items: z.array(
    z.object({
      id: z.uuid(),
      kind: backupItemKindSchema,
      serviceId: z.uuid().nullable(),
      lastSuccessAt: z.iso.datetime().nullable(),
      lastStatus: backupStatusSchema.nullable(),
    }),
  ),
  /** The latest restore (its job's progress), or null. */
  restore: backupRestoreSchema.nullable(),
  /** The latest repository check. */
  lastCheck: z
    .object({ at: z.iso.datetime(), status: backupStatusSchema, errorCode: z.string().nullable() })
    .nullable(),
});
export type BackupsStatus = z.infer<typeof backupsStatusSchema>;
