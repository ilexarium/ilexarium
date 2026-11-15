import type { BackupItemRequest } from '@ilex/shared';
import type { BackupPreset } from './backups.model';

/** An app's backup item as chosen: how, and its skips (relative to its folder). */
export function appItemWith(
  name: string,
  folder: string | null,
  { mode, skip }: BackupPreset,
): BackupItemRequest {
  return {
    kind: 'app',
    project: name,
    folders: [],
    skip: folder ? skip.map((s) => `${folder}/${s}`) : [],
    mode,
  };
}
