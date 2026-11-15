import type { AppDeleteRequest, AppTask, BackupItemRequest } from '@ilex/shared';

/** What happens once a task has succeeded, even after its page was left. */
export type AppFollowUp =
  | { kind: 'remove'; delete: AppDeleteRequest | null }
  | { kind: 'install'; backup: BackupItemRequest | null };

/**
 * A followed task as it goes. `after`: its follow-up, once the task succeeded — `pending` while it
 * runs, then `done` or `failed`; null without one (or while the task runs, or when it failed).
 */
export interface AppFollowed {
  task: AppTask;
  after: 'pending' | 'done' | 'failed' | null;
}
