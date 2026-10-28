import {
  type ActivityAction,
  APP_NAME_PATTERN,
  containerNameSchema,
  isMountPointAllowed,
  MODEL_NAME_PATTERN,
} from '@laris/shared';

const pattern = (regex: RegExp) => (value: string) => regex.test(value);
const containerName = (value: string) => containerNameSchema.safeParse(value).success;

/**
 * The one audit detail each action may show, and its check — every other detail stays in the
 * audit log. A value that fails the check is dropped, not shown.
 */
export const ACTIVITY_SUBJECTS: Record<
  ActivityAction,
  { field: string; valid: (value: string) => boolean } | null
> = {
  'app.install': { field: 'name', valid: pattern(APP_NAME_PATTERN) },
  'app.update': { field: 'name', valid: pattern(APP_NAME_PATTERN) },
  'app.remove': { field: 'name', valid: pattern(APP_NAME_PATTERN) },
  'container.start': { field: 'container', valid: containerName },
  'container.stop': { field: 'container', valid: containerName },
  'container.restart': { field: 'container', valid: containerName },
  'backup.configure': null,
  'backup.restore': null,
  'disk.mount': { field: 'mountPoint', valid: isMountPointAllowed },
  'disk.unmount': { field: 'mountPoint', valid: isMountPointAllowed },
  'assistant.model_pull': { field: 'model', valid: pattern(MODEL_NAME_PATTERN) },
};
