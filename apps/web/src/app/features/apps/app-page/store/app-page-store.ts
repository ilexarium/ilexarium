import { patchState, signalStore, withMethods } from '@ngrx/signals';
import {
  initialAppBackupState,
  initialAppDeletionState,
  initialAppDetailsState,
  initialAppTaskState,
} from './app-page-store.constants';
import { withAppBackup } from './with-app-backup';
import { withAppDeletion } from './with-app-deletion';
import { withAppDetails } from './with-app-details';
import { withAppFiles } from './with-app-files';
import { withAppTask } from './with-app-task';

/**
 * One app's page: the app as read, its task, its files being edited, its backup and deleting its
 * files — each a feature of its own. Every action is one request; a task is followed only to
 * show it.
 */
export const AppPageStore = signalStore(
  withAppDetails(),
  withAppTask(),
  withAppFiles(),
  withAppBackup(),
  withAppDeletion(),
  withMethods((store) => ({
    /** Another app (or the first): everything of the previous one gone, its task no longer followed. */
    open(name: string, folder: string | null): void {
      store._appChanged.next();
      store.follow(null);
      patchState(store, {
        ...initialAppDetailsState,
        ...initialAppTaskState,
        ...initialAppBackupState,
        ...initialAppDeletionState,
        name,
        folderHint: folder,
      });
      store.load();
    },
  })),
);
