import type { AppDeleteRequest, AppTask, BackupItemRequest } from '@ilex/shared';

/** What happens once a task has succeeded, even after its page was left. */
export type AppFollowUp =
  | { kind: 'remove'; delete: AppDeleteRequest | null }
  | { kind: 'install'; backup: BackupItemRequest | null };

/** A followed task as it goes; `done` once it succeeded and its follow-up went through. */
export interface AppFollowed {
  task: AppTask;
  done: boolean;
}
