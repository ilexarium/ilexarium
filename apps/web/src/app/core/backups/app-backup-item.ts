import type { AppSummary, BackupItemRequest } from '@ilex/shared';
import { firstValueFrom } from 'rxjs';
import type { AppsApi } from '../apps/apps-api';
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

/**
 * An app's backup item, with its template's preset when it has one (Ollama runs on, its models
 * skipped): the same wherever "Add to backups" is clicked.
 */
export async function appBackupItem(
  appsApi: AppsApi,
  app: Pick<AppSummary, 'name' | 'folder' | 'template'>,
): Promise<BackupItemRequest> {
  let preset: BackupPreset = { mode: 'stop', skip: [] };
  if (app.template && app.folder) {
    const found = await firstValueFrom(appsApi.template(app.template.id)).catch(() => null);
    const backup = found?.template.backup;
    if (backup) preset = { mode: backup.mode, skip: backup.skip ?? [] };
  }
  return appItemWith(app.name, app.folder, preset);
}
