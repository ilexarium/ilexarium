import {
  type ActivityAction,
  CATALOG_ID_PATTERN,
  containerNameSchema,
  DISK_NAME_PATTERN,
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
  'service.deploy': { field: 'catalogId', valid: pattern(CATALOG_ID_PATTERN) },
  'service.remove': { field: 'catalogId', valid: pattern(CATALOG_ID_PATTERN) },
  'container.start': { field: 'container', valid: containerName },
  'container.stop': { field: 'container', valid: containerName },
  'container.restart': { field: 'container', valid: containerName },
  'backup.configure': null,
  'backup.restore': null,
  'disk.mount': { field: 'name', valid: pattern(DISK_NAME_PATTERN) },
  'disk.unmount': { field: 'name', valid: pattern(DISK_NAME_PATTERN) },
  'assistant.model_pull': { field: 'model', valid: pattern(MODEL_NAME_PATTERN) },
};
