import type {
  AppBackupState,
  AppDeletionState,
  AppDetailsState,
  AppTaskState,
} from './app-page-store.model';

export const initialAppDetailsState: Omit<AppDetailsState, 'tab'> = {
  name: '',
  folderHint: null,
  details: null,
  loadError: null,
  requesting: false,
};

export const initialAppTaskState: AppTaskState = { followed: null, _givenUp: null };

export const initialAppBackupState: AppBackupState = { startedRun: null };

export const initialAppDeletionState: AppDeletionState = { removal: null, removed: false };
