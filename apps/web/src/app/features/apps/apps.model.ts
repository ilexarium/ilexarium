import type { AppTask } from '@laris/shared';

/** A field's change in the form. */
export interface FieldChange {
  key: string;
  value: string;
}

/** A task with the app it belongs to, as the task panel follows it. */
export interface FollowedTask {
  name: string;
  folder: string;
  task: AppTask;
}
