import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import type {
  BackupArchivesResponse,
  BackupDestinationsResponse,
  BackupFoldersResponse,
  BackupItem,
  BackupItemRequest,
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
import { firstValueFrom } from 'rxjs';

const id = encodeURIComponent;

/** The server's backup endpoints. Live status and progress arrive through the `backups` topic. */
@Service()
export class BackupsApi {
  private readonly http = inject(HttpClient);

  plan(): Promise<BackupPlanResponse> {
    return firstValueFrom(this.http.get<BackupPlanResponse>('/api/backups/plan'));
  }

  destinations(): Promise<BackupDestinationsResponse> {
    return firstValueFrom(this.http.get<BackupDestinationsResponse>('/api/backups/destinations'));
  }

  folders(path?: string): Promise<BackupFoldersResponse> {
    const params = path ? new HttpParams().set('path', path) : undefined;
    return firstValueFrom(this.http.get<BackupFoldersResponse>('/api/backups/folders', { params }));
  }

  /** Sets backups up; the response holds the passphrase, shown once. */
  setup(request: BackupSetupRequest): Promise<BackupPassphraseResponse> {
    return firstValueFrom(this.http.post<BackupPassphraseResponse>('/api/backups/plan', request));
  }

  updatePlan(request: BackupPlanUpdate): Promise<BackupPlan> {
    return firstValueFrom(this.http.put<BackupPlan>('/api/backups/plan', request));
  }

  addItem(item: BackupItemRequest): Promise<BackupItem> {
    return firstValueFrom(this.http.post<BackupItem>('/api/backups/items', { item }));
  }

  updateItem(itemId: string, excludedFields: string[]): Promise<BackupItem> {
    return firstValueFrom(
      this.http.patch<BackupItem>(`/api/backups/items/${id(itemId)}`, { excludedFields }),
    );
  }

  removeItem(itemId: string, deleteArchives: boolean): Promise<void> {
    const params = new HttpParams().set('archives', deleteArchives ? 'delete' : 'keep');
    return firstValueFrom(this.http.delete<void>(`/api/backups/items/${id(itemId)}`, { params }));
  }

  archives(itemId: string): Promise<BackupArchivesResponse> {
    return firstValueFrom(
      this.http.get<BackupArchivesResponse>(`/api/backups/items/${id(itemId)}/archives`),
    );
  }

  /** 202 once it started; it runs on. */
  runNow(itemId?: string): Promise<BackupRunStartedResponse> {
    return firstValueFrom(
      this.http.post<BackupRunStartedResponse>('/api/backups/runs', itemId ? { itemId } : {}),
    );
  }

  runs(): Promise<BackupRunsResponse> {
    return firstValueFrom(this.http.get<BackupRunsResponse>('/api/backups/runs'));
  }

  runOutput(runId: string): Promise<BackupRunOutputResponse> {
    return firstValueFrom(
      this.http.get<BackupRunOutputResponse>(`/api/backups/runs/${id(runId)}/output`),
    );
  }

  /** 202 once the restore started; it runs on as a job. */
  restore(request: BackupRestoreRequest): Promise<BackupRestoreStartedResponse> {
    return firstValueFrom(
      this.http.post<BackupRestoreStartedResponse>('/api/backups/restores', request),
    );
  }

  restores(): Promise<BackupRestoresResponse> {
    return firstValueFrom(this.http.get<BackupRestoresResponse>('/api/backups/restores'));
  }

  discardPrevious(restoreId: string): Promise<BackupRestore> {
    return firstValueFrom(
      this.http.delete<BackupRestore>(`/api/backups/restores/${id(restoreId)}/previous`),
    );
  }

  /** "Show again": needs the app password. */
  passphrase(password: string): Promise<BackupPassphraseResponse> {
    return firstValueFrom(
      this.http.post<BackupPassphraseResponse>('/api/backups/passphrase', { password }),
    );
  }
}
