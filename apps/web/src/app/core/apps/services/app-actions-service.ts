import { inject, Service } from '@angular/core';
import type {
  AppDeleteRequest,
  AppDetails,
  AppFields,
  AppInstallRequest,
  AppNameCheck,
  AppRemoval,
  AppSaveRequest,
  AppStarted,
  AppSummary,
  AppTask,
  AppsList,
  BackupItem,
  BackupItemRequest,
  BackupRunStartedResponse,
  TemplateDetails,
} from '@ilex/shared';
import { map, type Observable, of, switchMap } from 'rxjs';
import { buildAppBackupItem } from '../../backups/app-backup-item';
import { BackupsApi } from '../../backups/backups-api';
import type { BackupPreset } from '../../backups/backups.model';
import { LinuxSessionStore } from '../../linux/linux-session-store';
import { AppsApi } from '../apps-api';
import { followAppTask } from '../follow-app-task';
import { DEFAULT_BACKUP_PRESET } from './app-actions-service.constants';

/**
 * Apps' reads and actions for the stores: the API calls, the steps that belong together, and
 * every change as the signed-in Linux account (`asPerson`: the sign-in or sudo prompt first when
 * needed). Stateless: every method an Observable; a change gives null when the prompt was
 * dismissed, a refusal is its error, for the store to word.
 */
@Service()
export class AppActionsService {
  private readonly appsApi = inject(AppsApi);
  private readonly backupsApi = inject(BackupsApi);
  private readonly linuxSessionStore = inject(LinuxSessionStore);

  details(name: string, folder?: string): Observable<AppDetails> {
    return this.appsApi.details(name, folder);
  }

  followTask(name: string, folder: string): Observable<AppTask> {
    return followAppTask(this.appsApi, name, folder);
  }

  list(): Observable<AppsList> {
    return this.appsApi.list();
  }

  template(id: string): Observable<TemplateDetails> {
    return this.appsApi.template(id);
  }

  fields(template: string): Observable<AppFields> {
    return this.appsApi.fields({ template });
  }

  checkName(name: string): Observable<AppNameCheck> {
    return this.appsApi.checkName(name);
  }

  /** Signed in to Linux (true), or the sign-in dismissed (null). */
  signIn(): Observable<true | null> {
    return this.linuxSessionStore.asPerson$(() => of(true as const));
  }

  install(request: AppInstallRequest): Observable<AppStarted | null> {
    return this.linuxSessionStore.asPerson$(() => this.appsApi.install(request));
  }

  save(name: string, request: AppSaveRequest): Observable<AppStarted | null> {
    return this.linuxSessionStore.asPerson$(() => this.appsApi.save(name, request));
  }

  update(name: string, folder: string): Observable<AppStarted | null> {
    return this.linuxSessionStore.asPerson$(() => this.appsApi.update(name, folder));
  }

  start(name: string, folder: string): Observable<AppStarted | null> {
    return this.linuxSessionStore.asPerson$(() => this.appsApi.start(name, folder));
  }

  remove(name: string, folder: string): Observable<AppStarted | null> {
    return this.linuxSessionStore.asPerson$(() => this.appsApi.remove(name, folder));
  }

  removal(name: string, folder: string): Observable<AppRemoval | null> {
    return this.linuxSessionStore.asPerson$(() => this.appsApi.removal(name, folder));
  }

  deleteFiles(name: string, request: AppDeleteRequest): Observable<true | null> {
    return this.linuxSessionStore.asPerson$(() =>
      this.appsApi.delete(name, request).pipe(map(() => true as const)),
    );
  }

  backUpNow(itemId: string): Observable<BackupRunStartedResponse | null> {
    return this.linuxSessionStore.asPerson$(() => this.backupsApi.runNow(itemId));
  }

  /** Added to the backups with its template's preset; fails when the template can't be read. */
  addToBackups(
    app: Pick<AppSummary, 'name' | 'folder' | 'template'>,
  ): Observable<BackupItem | null> {
    return this.appBackupItem(app).pipe(
      switchMap((item) => this.linuxSessionStore.asPerson$(() => this.backupsApi.addItem(item))),
    );
  }

  /**
   * An app's backup item, with its template's preset when it has one (Ollama runs on, its models
   * skipped): the same wherever "Add to backups" is clicked. Fails when the template can't be
   * read — never a plain "stop, everything" instead.
   */
  appBackupItem(
    app: Pick<AppSummary, 'name' | 'folder' | 'template'>,
  ): Observable<BackupItemRequest> {
    const preset$: Observable<BackupPreset> =
      app.template && app.folder
        ? this.appsApi
            .template(app.template.id)
            .pipe(
              map(({ template }) =>
                template.backup
                  ? { mode: template.backup.mode, skip: template.backup.skip ?? [] }
                  : DEFAULT_BACKUP_PRESET,
              ),
            )
        : of(DEFAULT_BACKUP_PRESET);
    return preset$.pipe(map((preset) => buildAppBackupItem(app.name, app.folder, preset)));
  }
}
