import type { AppImage, AppTask } from '@laris/shared';

/** The versions an image has, as far as asked. */
export interface VersionList {
  loading: boolean;
  versions: string[];
  /** False: the registry wasn't reachable or wants a sign-in. */
  available: boolean;
}

/** A field's change in the form. */
export interface FieldChange {
  key: string;
  value: string;
}

/** A fixed tag's change (a pasted file's `image:` line). */
export interface ImageTagChange {
  image: AppImage;
  tag: string;
}

/** A task with the app it belongs to, as the task panel follows it. */
export interface FollowedTask {
  name: string;
  folder: string;
  task: AppTask;
}
