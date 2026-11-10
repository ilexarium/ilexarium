import type { BackupItem } from '@ilex/shared';

/** A backup item as the server sends it: a folder unless changed. */
export const testItem = (change: Partial<BackupItem> = {}): BackupItem => ({
  id: '0193a000-0000-7000-8000-000000000003',
  kind: 'folder',
  project: null,
  folders: [],
  otherFolders: [],
  skip: [],
  mode: null,
  appRemoved: false,
  path: '/srv/docs',
  removed: false,
  lastSuccessAt: null,
  lastResult: null,
  ...change,
});

/** An app's item: its folders as Docker shows them. */
export const testAppItem = (project: string, change: Partial<BackupItem> = {}): BackupItem =>
  testItem({
    kind: 'app',
    project,
    folders: [`/home/anna/apps/${project}/data`],
    mode: 'stop',
    path: null,
    ...change,
  });
