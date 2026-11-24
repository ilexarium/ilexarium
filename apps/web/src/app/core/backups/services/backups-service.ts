import { inject, Service } from '@angular/core';
import type {
  BackupArchivesResponse,
  BackupDestinationsResponse,
  BackupFoldersResponse,
  BackupItemUpdate,
  BackupPassphraseResponse,
  BackupPlan,
  BackupPlanResponse,
  BackupPlanUpdate,
  BackupRestoreRequest,
  BackupRunOutputResponse,
  BackupSetupRequest,
} from '@ilex/shared';
import { forkJoin, map, type Observable, of, switchMap } from 'rxjs';
import { AppActionsService } from '../../apps/services/app-actions-service';
import { LinuxSessionStore } from '../../linux/linux-session-store';
import { BackupsApi } from '../backups-api';
import type { AppForBackup, BackupHistory } from '../backups.model';

/**
 * The Backups page's reads and actions for its store: the API calls, and every change as the
 * signed-in Linux account (`asPerson$`: the sign-in or sudo prompt first when needed). Stateless:
 * every method an Observable; a change gives null when the prompt was dismissed (`true` when it
 * only needs to say it was done), a refusal is its error, for the store to word.
 */
@Service()
export class BackupsService {
  private readonly backupsApi = inject(BackupsApi);
  private readonly appActionsService = inject(AppActionsService);
  private readonly linuxSessionStore = inject(LinuxSessionStore);

  plan(): Observable<BackupPlanResponse> {
    return this.backupsApi.plan();
  }

  /** Runs and restores together. */
  history(): Observable<BackupHistory> {
    return forkJoin([this.backupsApi.runs(), this.backupsApi.restores()]).pipe(
      map(([{ runs }, { restores }]) => ({ runs, restores })),
    );
  }

  destinations(): Observable<BackupDestinationsResponse> {
    return this.backupsApi.destinations();
  }

  runOutput(runId: string): Observable<BackupRunOutputResponse> {
    return this.backupsApi.runOutput(runId);
  }

  /** The saved list of an item's archives. */
  archives(itemId: string): Observable<BackupArchivesResponse> {
    return this.backupsApi.archives(itemId);
  }

  /** The archive lists read again from the disk, through the person's sudo. */
  refreshArchives(): Observable<true | null> {
    return this.done(() => this.backupsApi.refreshArchives());
  }

  /** The folder picker: the starting places, or inside a folder, as the signed-in account. */
  folders(path?: string): Observable<BackupFoldersResponse | null> {
    return this.linuxSessionStore.asPerson$(() => this.backupsApi.folders(path));
  }

  /** Sets backups up with these apps (their templates' presets) and folders. */
  setup(
    settings: Omit<BackupSetupRequest, 'items'>,
    apps: AppForBackup[],
    folders: string[],
  ): Observable<BackupPassphraseResponse | null> {
    const appItems = apps.length
      ? forkJoin(apps.map((app) => this.appActionsService.appBackupItem(app)))
      : of([]);
    return appItems.pipe(
      switchMap((items) =>
        this.linuxSessionStore.asPerson$(() =>
          this.backupsApi.setup({
            ...settings,
            items: [...items, ...folders.map((path) => ({ kind: 'folder' as const, path }))],
          }),
        ),
      ),
    );
  }

  updatePlan(update: BackupPlanUpdate): Observable<BackupPlan | null> {
    return this.linuxSessionStore.asPerson$(() => this.backupsApi.updatePlan(update));
  }

  passphrase(): Observable<BackupPassphraseResponse | null> {
    return this.linuxSessionStore.asPerson$(() => this.backupsApi.passphrase());
  }

  /** The whole plan now, or one item. */
  runNow(itemId?: string): Observable<true | null> {
    return this.done(() => this.backupsApi.runNow(itemId));
  }

  /** An app added with its template's preset (read once signed in, like the adding). */
  addApp(app: AppForBackup): Observable<true | null> {
    return this.done(() =>
      this.appActionsService
        .appBackupItem(app)
        .pipe(switchMap((item) => this.backupsApi.addItem(item))),
    );
  }

  addFolder(path: string): Observable<true | null> {
    return this.done(() => this.backupsApi.addItem({ kind: 'folder', path }));
  }

  updateItem(itemId: string, change: BackupItemUpdate): Observable<true | null> {
    return this.done(() => this.backupsApi.updateItem(itemId, change));
  }

  /** Out of the plan; `deleteArchives` deletes its backups too. */
  removeItem(itemId: string, deleteArchives: boolean): Observable<true | null> {
    return this.done(() => this.backupsApi.removeItem(itemId, deleteArchives));
  }

  restore(request: BackupRestoreRequest): Observable<true | null> {
    return this.done(() => this.backupsApi.restore(request));
  }

  /** After a restore back where it was: the app's restored files applied. */
  applyRestored(restoreId: string, folder: string): Observable<true | null> {
    return this.done(() => this.backupsApi.applyRestored(restoreId, folder));
  }

  discardPrevious(restoreId: string): Observable<true | null> {
    return this.done(() => this.backupsApi.discardPrevious(restoreId));
  }

  /** As the person; `true` once answered — an empty answer (204) would be null, like a dismissal. */
  private done(request: () => Observable<unknown>): Observable<true | null> {
    return this.linuxSessionStore.asPerson$(() => request().pipe(map(() => true as const)));
  }
}
