import type { AppDetails, AppStarted, AppSummary, AppTask } from '@laris/shared';

export const testApp = (name: string, change: Partial<AppSummary> = {}): AppSummary => ({
  name,
  folder: `/home/anna/apps/${name}`,
  owner: 'anna',
  template: null,
  state: 'running',
  containers: [`${name}-server-1`],
  webPort: null,
  ...change,
});

export const testTask = (change: Partial<AppTask> = {}): AppTask => ({
  action: 'up',
  state: 'running',
  startedAt: '2026-10-28T12:00:00.000Z',
  system: false,
  output: [],
  next: 0,
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
  fields: [
    {
      key: 'VERSION',
      kind: 'version',
      value: '1.27',
      default: '1.27',
      required: false,
      advanced: false,
      image: 'nginx',
      fromTemplate: false,
    },
  ],
  images: [{ service: 'web', image: 'nginx', tag: null, variable: 'VERSION' }],
  problem: null,
  template: null,
  task: null,
  beforeUpdate: null,
  keptFiles: [],
  ...change,
});
