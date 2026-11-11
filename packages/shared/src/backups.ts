import { z } from 'zod';
import { APP_NAME_PATTERN } from './apps.js';
import {
  backupModeSchema,
  CATALOG_LIMITS,
  isPlainAbsolutePath,
  RELATIVE_PATH_PATTERN,
} from './catalog.js';

/**
 * Automated backups: daily, encrypted, deduplicated Borg backups of the platform, apps and chosen
 * folders, to one disk. Runs happen in a root program (started by a systemd timer, or "Back up
 * now" through the person's sudo); the app reads their results and live progress from the
 * program's files and pushes them through the `backups` topic. Viewing needs no password; every
 * change goes through the signed-in person's sudo.
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

/** The repository's folder on the chosen disk: `<mount point>/ilex-backups`. */
export const BACKUP_REPOSITORY_FOLDER = 'ilex-backups';
/** Disk formats a repository may be on. */
export const BACKUP_FILESYSTEMS = ['ext4', 'btrfs', 'xfs', 'exfat'] as const;

/**
 * Folders never backed up or restored into, whatever is asked: the system's, Docker's own and the
 * platform's private ones. Root reads everything else.
 */
export const BACKUP_SYSTEM_FOLDERS = [
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/lib',
  '/lib32',
  '/lib64',
  '/proc',
  '/root',
  '/run',
  '/sbin',
  '/sys',
  '/usr',
  '/var/lib/docker',
  '/var/lib/ilex',
  '/var/run',
  '/opt/ilex',
] as const;

/** Neither inside a system folder nor holding one (never `/`). */
export function isBackupFolder(path: string): boolean {
  const inside = (a: string, b: string) => a === b || a.startsWith(`${b}/`);
  return (
    isPlainAbsolutePath(path) &&
    path !== '/' &&
    !BACKUP_SYSTEM_FOLDERS.some((folder) => inside(path, folder) || inside(folder, path))
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

export const BACKUP_ITEM_KINDS = ['platform', 'app', 'folder'] as const;
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
  /** The root program didn't run (not installed, or sudo couldn't start it). */
  programUnavailable: 'program_unavailable',
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
  runNotFound: 'backup_run_not_found',
  pathNotAllowed: 'path_not_allowed',
  pathNotFound: 'path_not_found',
  /** Setting up on a disk that already has a `ilex-backups` folder that isn't ours. */
  repositoryExists: 'repository_exists',
  /** Restoring into a folder that has something in it already. */
  targetNotEmpty: 'target_not_empty',
  /** The backup wrapper refused the plan (its own checks) — nothing was changed. */
  invalidPlan: 'invalid_plan',
  /** An item's backups can't be deleted while a restore keeps a previous version of it. */
  setAsideKept: 'backup_set_aside_kept',
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
  /** `app`: its Compose project (its name). */
  project: z.string().nullable(),
  /** `app`: the folders backed up (its own folder and its mounts, those ticked). */
  folders: z.array(z.string()),
  /** `app`: folders it uses (as Docker sees them now) that aren't backed up. */
  otherFolders: z.array(z.string()),
  /** `app`: what's skipped inside its folders (absolute; `*` within a name). */
  skip: z.array(z.string()),
  /** `app`: stopped while it's copied, or copied while it runs. */
  mode: backupModeSchema.nullable(),
  /** `app`: Docker has no containers of it any more ("app removed"). */
  appRemoved: z.boolean(),
  /** `folder`: the folder. */
  path: z.string().nullable(),
  /** Removed from the plan: no longer backed up, its archives kept until deleted. */
  removed: z.boolean(),
  lastSuccessAt: z.iso.datetime().nullable(),
  /** Its part of the latest run that included it. */
  lastResult: backupItemResultSchema.nullable(),
});
export type BackupItem = z.infer<typeof backupItemSchema>;

// The plan.

export const backupPlanSchema = z.object({
  /** The chosen disk's mount point; the repository is `<mountPoint>/ilex-backups`. */
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
 * A disk's mount point. That it's one of the mounted disks that aren't system disks (the
 * server's list, which development points at pretend disks) is the server's check, and the
 * program's.
 */
const destinationSchema = z
  .string()
  .min(1, 'validation.backupDestinationRequired')
  .refine(isPlainAbsolutePath, 'validation.backupDestinationInvalid');

/** A folder to back up: anywhere but a system folder. */
const folderPathSchema = z
  .string()
  .min(1, 'validation.pathRequired')
  .refine(isPlainAbsolutePath, 'validation.pathInvalid')
  .refine(isBackupFolder, 'validation.backupFolderSystem');

/** A skip: an absolute path inside one of the item's folders, `*` and `?` within a name. */
export const backupItemSkipSchema = z
  .string()
  .max(CATALOG_LIMITS.pathMax)
  .refine(
    (path) => path.startsWith('/') && RELATIVE_PATH_PATTERN.test(path.slice(1)),
    'validation.backupSkipInvalid',
  );

const appItemFields = {
  folders: z.array(folderPathSchema).max(CATALOG_LIMITS.maxFields),
  skip: z.array(backupItemSkipSchema).max(CATALOG_LIMITS.maxBackupSkips),
  mode: backupModeSchema,
};

export const backupItemRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('app'),
    project: z.string().regex(APP_NAME_PATTERN),
    ...appItemFields,
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
 * The passphrase, shown once at setup ("I've saved it") and again through the person's sudo.
 * Never stored by the app, never in logs or output.
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

/** `PATCH /api/backups/items/:id`: an app item's folders, skips and mode. */
export const backupItemUpdateSchema = z.strictObject({
  folders: appItemFields.folders.optional(),
  skip: appItemFields.skip.optional(),
  mode: backupModeSchema.optional(),
});
export type BackupItemUpdate = z.infer<typeof backupItemUpdateSchema>;

/** `POST /api/backups/runs`: "Back up now" — everything, or one item. */
export const backupRunRequestSchema = z.strictObject({ itemId: z.uuid().optional() });
export type BackupRunRequest = z.infer<typeof backupRunRequestSchema>;

/**
 * `POST /api/backups/restores`: `target` null puts it back where it was (each current folder set
 * aside as `<folder>.before-restore-<date>` first; an app using it stopped, then brought up with
 * the restored files); a path restores everything below that folder instead (missing or empty), with its full
 * paths. Runs as its own unit, through the person's sudo.
 */
/** Archive names as the wrapper makes them: `<item uuid>-<YYYY-MM-DDTHH:MM:SS>`. */
export const BACKUP_ARCHIVE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

export const backupRestoreRequestSchema = z.strictObject({
  itemId: z.uuid(),
  archive: z.string().regex(BACKUP_ARCHIVE_PATTERN),
  target: folderPathSchema.nullable(),
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

export const backupRestoreStartedResponseSchema = z.object({ restoreId: z.uuid() });
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

/** What a running item is doing, as the program reports it. */
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

export const BACKUP_RESTORE_STATUSES = ['running', 'succeeded', 'failed', 'interrupted'] as const;
export const backupRestoreStatusSchema = z.enum(BACKUP_RESTORE_STATUSES);
export type BackupRestoreStatus = z.infer<typeof backupRestoreStatusSchema>;

/** What a restore is doing: stopping the app, restoring, starting it again. */
export const BACKUP_RESTORE_PHASES = ['stopping', 'restoring', 'starting', 'done'] as const;
export const backupRestorePhaseSchema = z.enum(BACKUP_RESTORE_PHASES);
export type BackupRestorePhase = z.infer<typeof backupRestorePhaseSchema>;

export const backupRestoreSchema = z.object({
  id: z.uuid(),
  itemId: z.uuid(),
  archive: z.string(),
  /** Null: back where it was. */
  targetPath: z.string().nullable(),
  /** Back where it was: the folders set aside — the way back, until "Delete previous version". */
  setAside: z.array(z.string()),
  setAsideDeleted: z.boolean(),
  /** Back where it was, an app that was running: its restored files can be applied ("Apply"). */
  appWasRunning: z.boolean(),
  status: backupRestoreStatusSchema,
  phase: backupRestorePhaseSchema.nullable(),
  errorCode: z.string().nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  /** The latest output lines. */
  output: z.array(z.string()),
});
export type BackupRestore = z.infer<typeof backupRestoreSchema>;

export const backupRestoreIdParamsSchema = z.strictObject({ id: z.uuid() });

/** `POST /api/backups/restores/:id/apply`: the restored app's folder (as Docker's labels say). */
export const backupRestoreApplySchema = z.strictObject({ folder: folderPathSchema });
export type BackupRestoreApply = z.infer<typeof backupRestoreApplySchema>;
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
      /** May be backed up (not a system folder). */
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
  /** Each active item's latest outcome, for "Backed up · last night" on app cards. */
  items: z.array(
    z.object({
      id: z.uuid(),
      kind: backupItemKindSchema,
      project: z.string().nullable(),
      lastSuccessAt: z.iso.datetime().nullable(),
      lastStatus: backupStatusSchema.nullable(),
    }),
  ),
  /** The latest restore (its progress), or null. */
  restore: backupRestoreSchema.nullable(),
  /** The latest repository check. */
  lastCheck: z
    .object({ at: z.iso.datetime(), status: backupStatusSchema, errorCode: z.string().nullable() })
    .nullable(),
});
export type BackupsStatus = z.infer<typeof backupsStatusSchema>;
