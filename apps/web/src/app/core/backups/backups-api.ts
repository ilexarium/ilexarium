import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import type {
  AppStarted,
  BackupArchivesResponse,
  BackupDestinationsResponse,
  BackupFoldersResponse,
  BackupItem,
  BackupItemRequest,
  BackupItemUpdate,
  BackupPassphraseResponse,
  BackupPlan,
  BackupPlanResponse,
  BackupPlanUpdate,
  BackupRestore,
  BackupRestoreRequest,
  BackupRestoresResponse,
  BackupRestoreStartedResponse,
  BackupRunOutputResponse,
  BackupRunsResponse,
  BackupRunStartedResponse,
  BackupSetupRequest,
} from '@laris/shared';
import type { Observable } from 'rxjs';

const id = encodeURIComponent;

/** The server's backup endpoints. Live status and progress arrive through the `backups` topic. */
@Service()
export class BackupsApi {
  private readonly http = inject(HttpClient);

  plan(): Observable<BackupPlanResponse> {
    return this.http.get<BackupPlanResponse>('/api/backups/plan');
  }

  destinations(): Observable<BackupDestinationsResponse> {
    return this.http.get<BackupDestinationsResponse>('/api/backups/destinations');
  }

  folders(path?: string): Observable<BackupFoldersResponse> {
    const params = path ? new HttpParams().set('path', path) : undefined;
    return this.http.get<BackupFoldersResponse>('/api/backups/folders', { params });
  }

  /** Sets backups up; the response holds the passphrase, shown once. */
  setup(request: BackupSetupRequest): Observable<BackupPassphraseResponse> {
    return this.http.post<BackupPassphraseResponse>('/api/backups/plan', request);
  }

  updatePlan(request: BackupPlanUpdate): Observable<BackupPlan> {
    return this.http.put<BackupPlan>('/api/backups/plan', request);
  }

  addItem(item: BackupItemRequest): Observable<BackupItem> {
    return this.http.post<BackupItem>('/api/backups/items', { item });
  }

  updateItem(itemId: string, change: BackupItemUpdate): Observable<BackupItem> {
    return this.http.patch<BackupItem>(`/api/backups/items/${id(itemId)}`, change);
  }

  removeItem(itemId: string, deleteArchives: boolean): Observable<void> {
    const params = new HttpParams().set('archives', deleteArchives ? 'delete' : 'keep');
    return this.http.delete<void>(`/api/backups/items/${id(itemId)}`, { params });
  }

  archives(itemId: string): Observable<BackupArchivesResponse> {
    return this.http.get<BackupArchivesResponse>(`/api/backups/items/${id(itemId)}/archives`);
  }

  /** 202 once it started; it runs on. */
  runNow(itemId?: string): Observable<BackupRunStartedResponse> {
    return this.http.post<BackupRunStartedResponse>('/api/backups/runs', itemId ? { itemId } : {});
  }

  runs(): Observable<BackupRunsResponse> {
    return this.http.get<BackupRunsResponse>('/api/backups/runs');
  }

  runOutput(runId: string): Observable<BackupRunOutputResponse> {
    return this.http.get<BackupRunOutputResponse>(`/api/backups/runs/${id(runId)}/output`);
  }

  /** 202 once the restore started; it runs on as a job. */
  restore(request: BackupRestoreRequest): Observable<BackupRestoreStartedResponse> {
    return this.http.post<BackupRestoreStartedResponse>('/api/backups/restores', request);
  }

  restores(): Observable<BackupRestoresResponse> {
    return this.http.get<BackupRestoresResponse>('/api/backups/restores');
  }

  /** "Apply the restored settings": the app's `up` task, as the person. */
  applyRestored(restoreId: string, folder: string): Observable<AppStarted> {
    return this.http.post<AppStarted>(`/api/backups/restores/${id(restoreId)}/apply`, { folder });
  }

  discardPrevious(restoreId: string): Observable<BackupRestore> {
    return this.http.delete<BackupRestore>(`/api/backups/restores/${id(restoreId)}/previous`);
  }

  /** "Show again": needs the app password. */
  passphrase(): Observable<BackupPassphraseResponse> {
    return this.http.post<BackupPassphraseResponse>('/api/backups/passphrase', {});
  }
}
