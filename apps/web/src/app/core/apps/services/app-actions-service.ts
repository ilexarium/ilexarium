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
import { firstValueFrom, type Observable } from 'rxjs';
import { buildAppBackupItem } from '../../backups/app-backup-item';
import { BackupsApi } from '../../backups/backups-api';
import type { BackupPreset } from '../../backups/backups.model';
import { LinuxSessionStore } from '../../linux/linux-session-store';
import { AppsApi } from '../apps-api';
import { followAppTask } from '../follow-app-task';

/**
 * Apps' reads and actions for the stores: the API calls, the steps that belong together, and
 * every change as the signed-in Linux account (`asPerson`: the sign-in or sudo prompt first when
 * needed). Stateless: reads are Observables, changes Promises — null when the prompt was
 * dismissed; a refusal throws, for the store to word.
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
  signIn(): Promise<true | null> {
    return this.linuxSessionStore.asPerson(async () => true as const);
  }

  install(request: AppInstallRequest): Promise<AppStarted | null> {
    return this.asPerson(() => this.appsApi.install(request));
  }

  save(name: string, request: AppSaveRequest): Promise<AppStarted | null> {
    return this.asPerson(() => this.appsApi.save(name, request));
  }

  update(name: string, folder: string): Promise<AppStarted | null> {
    return this.asPerson(() => this.appsApi.update(name, folder));
  }

  start(name: string, folder: string): Promise<AppStarted | null> {
    return this.asPerson(() => this.appsApi.start(name, folder));
  }

  remove(name: string, folder: string): Promise<AppStarted | null> {
    return this.asPerson(() => this.appsApi.remove(name, folder));
  }

  removal(name: string, folder: string): Promise<AppRemoval | null> {
    return this.asPerson(() => this.appsApi.removal(name, folder));
  }

  async deleteFiles(name: string, request: AppDeleteRequest): Promise<true | null> {
    return this.linuxSessionStore.asPerson(async () => {
      await firstValueFrom(this.appsApi.delete(name, request));
      return true as const;
    });
  }

  backUpNow(itemId: string): Promise<BackupRunStartedResponse | null> {
    return this.asPerson(() => this.backupsApi.runNow(itemId));
  }

  /** Added to the backups with its template's preset; throws when the template can't be read. */
  async addToBackups(
    app: Pick<AppSummary, 'name' | 'folder' | 'template'>,
  ): Promise<BackupItem | null> {
    const item = await this.appBackupItem(app);
    return this.asPerson(() => this.backupsApi.addItem(item));
  }

  /**
   * An app's backup item, with its template's preset when it has one (Ollama runs on, its models
   * skipped): the same wherever "Add to backups" is clicked. Rejects when the template can't be
   * read — never a plain "stop, everything" instead.
   */
  async appBackupItem(
    app: Pick<AppSummary, 'name' | 'folder' | 'template'>,
  ): Promise<BackupItemRequest> {
    let preset: BackupPreset = { mode: 'stop', skip: [] };
    if (app.template && app.folder) {
      const { template } = await firstValueFrom(this.appsApi.template(app.template.id));
      if (template.backup)
        preset = { mode: template.backup.mode, skip: template.backup.skip ?? [] };
    }
    return buildAppBackupItem(app.name, app.folder, preset);
  }

  /** The request made only once signed in (and again after a sudo prompt). */
  private asPerson<T>(request: () => Observable<T>): Promise<T | null> {
    return this.linuxSessionStore.asPerson(() => firstValueFrom(request()));
  }
}
