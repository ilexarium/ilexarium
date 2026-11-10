import type {
  AppDetails,
  AppStarted,
  AppSummary,
  AppTask,
  Container,
  TemplateSummary,
} from '@ilex/shared';

export const testApp = (name: string, change: Partial<AppSummary> = {}): AppSummary => ({
  name,
  folder: `/home/anna/apps/${name}`,
  owner: 'anna',
  template: null,
  state: 'running',
  containers: [`${name}-server-1`],
  webPort: null,
  webPath: '/',
  ...change,
});

export const testTask = (change: Partial<AppTask> = {}): AppTask => ({
  action: 'up',
  state: 'running',
  startedAt: '2026-10-28T12:00:00.000Z',
  system: false,
  output: [],
  ...change,
});

export const testStarted = (name: string, task: Partial<AppTask> = {}): AppStarted => ({
  name,
  folder: `/home/anna/apps/${name}`,
  task: testTask(task),
});

export const testDetails = (name: string, change: Partial<AppDetails> = {}): AppDetails => ({
  app: testApp(name),
  folder: `/home/anna/apps/${name}`,
  compose: 'services:\n  web:\n    image: nginx:${VERSION:-1.27}\n',
  env: 'VERSION=1.27\n',
  hash: 'h1',
  fields: [],
  template: null,
  task: null,
  ...change,
});

export const testTemplate = (
  id: string,
  change: Partial<TemplateSummary> = {},
): TemplateSummary => ({
  id,
  version: '1',
  name: id,
  category: 'media',
  website: `https://example.com/${id}`,
  webPort: null,
  webPath: '/',
  backupRestoreNote: false,
  ...change,
});

/** A running container of the Compose project `app` (none: a loose one), with stats. */
export const testContainer = (
  name: string,
  app: string | null,
  change: Partial<Container> = {},
): Container => ({
  id: name,
  name,
  image: 'example/x:1',
  state: 'running',
  health: 'none',
  startedAt: null,
  ports: [],
  protected: false,
  composeProject: app,
  composeWorkingDir: app ? `/home/anna/apps/${app}` : null,
  template: null,
  stats: {
    at: 1,
    cpuPercent: 2,
    memoryUsedBytes: 50_000_000,
    memoryLimitBytes: 1_000_000_000,
    netRxBytes: 0,
    netTxBytes: 0,
    blockReadBytes: 0,
    blockWriteBytes: 0,
  },
  ...change,
});
