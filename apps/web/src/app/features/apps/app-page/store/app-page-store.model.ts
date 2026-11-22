import type { AppDetails, AppRemovalItem, AppTask } from '@ilex/shared';
import type { AppTab } from '../../apps.model';

export interface AppDetailsState {
  name: string;
  folderHint: string | null;
  details: AppDetails | null;
  /** Why it couldn't be read (an error code), or null. */
  loadError: string | null;
  /** A request of this page's in flight. */
  requesting: boolean;
  /** The open tab (the page keeps it in the URL). */
  tab: AppTab;
}

export interface AppTaskState {
  /** The task this page follows, as last read. */
  followed: AppTask | null;
  /** When the task followed until polling gave up started: not shown running, not followed again. */
  _givenUp: string | null;
}

export interface AppBackupState {
  /** The backup run "Back up now" started, until the backups topic shows it ended. */
  startedRun: string | null;
}

export interface AppDeletionState {
  /** What "Delete files" may delete; null while it loads. */
  removal: AppRemovalItem[] | null;
  /** Its settings deleted: back to the list. */
  removed: boolean;
}
