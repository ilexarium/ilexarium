import type { AppTask } from '@ilex/shared';

/** What an app task does; `watched`: one found running, started elsewhere. */
export type AppTaskKind = 'save' | 'update' | 'start' | 'remove' | 'install' | 'watched';

/**
 * An app's latest task as `AppTasksStore` follows it. `id`: higher for one started later. `after`:
 * its second step (a removal's deletion, a new app added to the backups; a card's start toast),
 * once the task succeeded — `pending` while it runs, then `done` or `failed`; null without one, or
 * while the task runs, or when it failed.
 */
export interface AppTaskEntry {
  id: number;
  kind: AppTaskKind;
  folder: string;
  task: AppTask;
  after: 'pending' | 'done' | 'failed' | null;
}
