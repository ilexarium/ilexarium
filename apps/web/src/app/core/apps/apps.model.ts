import type { AppStarted, AppTask } from '@ilex/shared';
import type { Observable } from 'rxjs';

/**
 * A followed task as it goes. `after`: its second step (a removal's deletion, a new app added to
 * the backups), once the task succeeded — `pending` while it runs, then `done` or `failed`; null
 * without one (or while the task runs, or when it failed).
 */
export interface AppFollowed {
  task: AppTask;
  after: 'pending' | 'done' | 'failed' | null;
}

/** A task with a second step, started: what the server answered, and its progress to show. */
export interface AppTaskStart {
  started: AppStarted;
  followed$: Observable<AppFollowed>;
}
