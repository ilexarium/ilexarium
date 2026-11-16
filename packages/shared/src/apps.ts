import { z } from 'zod';
import type { Container } from './monitoring.js';
import { CATALOG_ID_PATTERN, fieldKindSchema, isPlainAbsolutePath } from './catalog.js';

/**
 * Apps: Compose folders, by default `~/apps/<name>/`, run as
 * the signed-in Linux account. Docker's labels and the files are the only record. Reading the
 * list needs no sign-in (Docker, through the read-only proxy); everything else is done as the
 * person, through their Linux session.
 */

/** A Compose project's name, as Compose allows it: also the app's name. */
export const APP_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
/** A named Docker volume (Docker's own rule). */
export const VOLUME_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

/** On an app's containers: the template it came from, `<id>@<version>`. */
export const TEMPLATE_LABEL = 'ilex.template';
export const TEMPLATE_LABEL_PATTERN = /^([a-z0-9][a-z0-9-]{0,39})@([0-9]{1,6})$/;

export const APP_LIMITS = {
  /** compose.yml and .env, each. */
  fileMaxBytes: 256 * 1024,
  /** A variable's value: one line. */
  valueMax: 4096,
  /** How often the web asks for a running task's output. */
  taskPollMs: 1000,
} as const;

/** The folder an app gets by default, inside the person's home. */
export const APPS_FOLDER = 'apps';

export const appNameSchema = z.string().regex(APP_NAME_PATTERN, 'validation.appNameInvalid');

const absolutePath = z
  .string()
  .min(1, 'validation.pathRequired')
  .refine(isPlainAbsolutePath, 'validation.pathInvalid');

const fileText = z.string().max(APP_LIMITS.fileMaxBytes, 'validation.fileTooLarge');

export const APP_STATES = ['running', 'partial', 'stopped', 'unhealthy', 'none'] as const;
export const appStateSchema = z.enum(APP_STATES);
export type AppState = z.infer<typeof appStateSchema>;

/** One app of `GET /api/apps`. */
export const appSummarySchema = z.object({
  name: z.string(),
  /** Its folder (Compose's working directory); null when Docker doesn't say. */
  folder: z.string().nullable(),
  /** The account whose home it's in (`/home/<name>/…`); null elsewhere. */
  owner: z.string().nullable(),
  /** The template it came from (its containers' label). */
  template: z.object({ id: z.string(), version: z.string() }).nullable(),
  /** `none`: no containers (removed, or never started), its folder still there. */
  state: appStateSchema,
  containers: z.array(z.string()),
  /** The published port of its web page (the "Open" link). */
  webPort: z.number().int().nullable(),
  /** The path of its web page (`/` unless its template says). */
  webPath: z.string(),
});
export type AppSummary = z.infer<typeof appSummarySchema>;

export const appsListSchema = z.object({ apps: z.array(appSummarySchema) });
export type AppsList = z.infer<typeof appsListSchema>;

// The form.

/** One variable of a template's setup form. */
export const appFieldSchema = z.object({
  key: z.string(),
  kind: fieldKindSchema,
  /** From `.env`, else the default, else empty (a `generated` one: made now). */
  value: z.string(),
  /** The template's default, its tokens filled in. */
  default: z.string().nullable(),
  /** No default: it needs a value. */
  required: z.boolean(),
  advanced: z.boolean(),
});
export type AppField = z.infer<typeof appFieldSchema>;

export const appFieldsRequestSchema = z.strictObject({
  template: z.string().regex(CATALOG_ID_PATTERN),
});
export type AppFieldsRequest = z.infer<typeof appFieldsRequestSchema>;

export const appFieldsSchema = z.object({ fields: z.array(appFieldSchema) });
export type AppFields = z.infer<typeof appFieldsSchema>;

// The name.

export const appNameQuerySchema = z.strictObject({ name: z.string().max(200) });
export type AppNameQuery = z.infer<typeof appNameQuerySchema>;

export const appNameCheckSchema = z.object({
  /** No Compose project and no folder of this name. */
  free: z.boolean(),
  /** A free name like it (`immich-2`). */
  suggestion: z.string(),
});
export type AppNameCheck = z.infer<typeof appNameCheckSchema>;

// Tasks.

export const APP_TASK_ACTIONS = ['up', 'update', 'down'] as const;
export const appTaskActionSchema = z.enum(APP_TASK_ACTIONS);
export type AppTaskAction = z.infer<typeof appTaskActionSchema>;

export const APP_TASK_STATES = ['running', 'succeeded', 'failed', 'interrupted'] as const;
export const appTaskStateSchema = z.enum(APP_TASK_STATES);
export type AppTaskState = z.infer<typeof appTaskStateSchema>;

/** A long task (a unit): the end of its output. */
export const appTaskSchema = z.object({
  action: appTaskActionSchema,
  state: appTaskStateSchema,
  startedAt: z.iso.datetime(),
  /** Ran through the account's sudo (a system unit). */
  system: z.boolean(),
  /** Its last lines (a long output: its end, where a failure says why). */
  output: z.array(z.string()),
});
export type AppTask = z.infer<typeof appTaskSchema>;

// Installing.

export const appInstallRequestSchema = z.strictObject({
  name: appNameSchema,
  /** Null: `~/apps/<name>`. */
  folder: absolutePath.nullable(),
  template: z.string().regex(CATALOG_ID_PATTERN).nullable(),
  compose: fileText.min(1, 'validation.composeRequired'),
  env: fileText,
});
export type AppInstallRequest = z.infer<typeof appInstallRequestSchema>;

/** After an install, a change, an update or a removal started. */
export const appStartedSchema = z.object({
  name: z.string(),
  folder: z.string(),
  task: appTaskSchema,
});
export type AppStarted = z.infer<typeof appStartedSchema>;

// One app.

export const appParamsSchema = z.strictObject({ name: appNameSchema });
export type AppParams = z.infer<typeof appParamsSchema>;

/** Which app folder: Docker's (by its name), else this one (`?folder=`), else `~/apps/<name>`. */
export const appFolderQuerySchema = z.strictObject({ folder: absolutePath.optional() });
export type AppFolderQuery = z.infer<typeof appFolderQuerySchema>;

export const appDetailsSchema = z.object({
  app: appSummarySchema,
  folder: z.string(),
  compose: z.string(),
  env: z.string(),
  /** Of both files as read: a save with another one was changed on disk meanwhile. */
  hash: z.string(),
  /** Its template's form; none without a template (the files alone). */
  fields: z.array(appFieldSchema),
  /** The template it came from (its texts), or null. */
  template: z.object({ id: z.string(), version: z.string() }).nullable(),
  /** Its latest task. */
  task: appTaskSchema.nullable(),
});
export type AppDetails = z.infer<typeof appDetailsSchema>;

export const appSaveRequestSchema = z.strictObject({
  folder: absolutePath,
  compose: fileText.min(1, 'validation.composeRequired'),
  env: fileText,
  /** The hash they were read with; ignored with `overwrite`. */
  hash: z.string().max(128),
  overwrite: z.boolean(),
});
export type AppSaveRequest = z.infer<typeof appSaveRequestSchema>;

export const appUpdateRequestSchema = z.strictObject({ folder: absolutePath });
export type AppUpdateRequest = z.infer<typeof appUpdateRequestSchema>;

// Removing.

export const APP_REMOVAL_KINDS = ['settings', 'folder', 'volume'] as const;
export const appRemovalItemSchema = z.object({
  kind: z.enum(APP_REMOVAL_KINDS),
  /** A folder's path or a volume's name; the settings: the app's folder. */
  path: z.string(),
  bytes: z.number().nullable(),
  /** Outside the app's folder: may be used elsewhere. */
  outside: z.boolean(),
});
export type AppRemovalItem = z.infer<typeof appRemovalItemSchema>;

export const appRemovalSchema = z.object({ items: z.array(appRemovalItemSchema) });
export type AppRemoval = z.infer<typeof appRemovalSchema>;

/** After `down`: what to delete — every item the person ticked. */
export const appDeleteRequestSchema = z.strictObject({
  folder: absolutePath,
  settings: z.boolean(),
  folders: z.array(absolutePath).max(50),
  volumes: z.array(z.string().regex(VOLUME_NAME_PATTERN)).max(50),
});
export type AppDeleteRequest = z.infer<typeof appDeleteRequestSchema>;

// Errors.

export const APP_ERROR_CODES = {
  notFound: 'app_not_found',
  nameTaken: 'app_name_taken',
  folderExists: 'app_folder_exists',
  composeInvalid: 'compose_invalid',
  changedOnDisk: 'changed_on_disk',
  taskRunning: 'app_task_running',
  taskNotStarted: 'app_task_not_started',
  dockerUnavailable: 'docker_unavailable',
  templateNotFound: 'catalog_entry_not_found',
  pathProtected: 'path_protected',
  /** Another account could change the folder, a folder above it or its Compose files. */
  folderUnsafe: 'app_folder_unsafe',
  /** Docker runs this app from another folder than the one asked about. */
  folderMismatch: 'app_folder_mismatch',
  failed: 'app_failed',
} as const;
export type AppErrorCode = (typeof APP_ERROR_CODES)[keyof typeof APP_ERROR_CODES];

// Paths.

export const APPS_PATH = '/api/apps';
export const APP_FIELDS_PATH = `${APPS_PATH}/fields`;
export const APP_NAME_CHECK_PATH = `${APPS_PATH}/name`;

export function appPath(name: string): string {
  return `${APPS_PATH}/${encodeURIComponent(name)}`;
}

/** The app's files: `PUT` saves them and applies them. */
export const appFilesPath = (name: string) => `${appPath(name)}/files`;
export const appTaskPath = (name: string) => `${appPath(name)}/task`;
export const appUpdatePath = (name: string) => `${appPath(name)}/update`;
export const appStartPath = (name: string) => `${appPath(name)}/start`;
export const appRemovalPath = (name: string) => `${appPath(name)}/removal`;
export const appRemovePath = (name: string) => `${appPath(name)}/remove`;
export const appDeletePath = (name: string) => `${appPath(name)}/delete`;

/** A variable's name in an `.env` file or a form. */
export const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** The account an app's folder is in (`/home/<name>/…`), or null. */
export function folderOwner(folder: string | null): string | null {
  return /^\/home\/([^/]+)\//.exec(folder ?? '')?.[1] ?? null;
}

/** An app's state from its containers. */
export function appState(containers: readonly Pick<Container, 'state' | 'health'>[]): AppState {
  if (containers.length === 0) return 'none';
  if (containers.some((c) => c.health === 'unhealthy')) return 'unhealthy';
  const running = containers.filter((c) => c.state === 'running').length;
  if (running === 0) return 'stopped';
  return running < containers.length ? 'partial' : 'running';
}

/**
 * The apps Docker knows: one per Compose project, the platform's own (protected) left out. Its
 * "Open" port: where the template's web port (inside the container) is published, else the first
 * TCP port published beyond loopback.
 */
export function appsFromContainers(
  containers: readonly Omit<Container, 'stats'>[],
  webPages: (templateId: string) => { port: number; path: string } | null = () => null,
): AppSummary[] {
  const projects = new Map<string, Omit<Container, 'stats'>[]>();
  for (const container of containers) {
    if (!container.composeProject) continue;
    const list = projects.get(container.composeProject) ?? [];
    list.push(container);
    projects.set(container.composeProject, list);
  }
  const apps: AppSummary[] = [];
  for (const [name, own] of projects) {
    if (own.some((c) => c.protected)) continue;
    const folder = own.find((c) => c.composeWorkingDir)?.composeWorkingDir ?? null;
    const label = own.map((c) => TEMPLATE_LABEL_PATTERN.exec(c.template ?? '')).find(Boolean);
    const template = label ? { id: label[1], version: label[2] } : null;
    const published = own.flatMap((c) => c.ports).filter((p) => p.publicPort !== undefined);
    const wanted = template ? webPages(template.id) : null;
    const web =
      wanted !== null
        ? published.find((p) => p.privatePort === wanted.port)
        : published.find((p) => p.protocol === 'tcp' && p.ip !== '127.0.0.1' && p.ip !== '::1');
    apps.push({
      name,
      folder,
      owner: folderOwner(folder),
      template,
      state: appState(own),
      containers: own.map((c) => c.name).sort(),
      webPort: web?.publicPort ?? null,
      webPath: wanted?.path ?? '/',
    });
  }
  return apps.sort((a, b) => a.name.localeCompare(b.name));
}
