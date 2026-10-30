import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import {
  APP_FIELDS_PATH,
  APP_NAME_CHECK_PATH,
  type AppDeleteRequest,
  type AppDetails,
  type AppFields,
  type AppFieldsRequest,
  type AppInstallRequest,
  type AppNameCheck,
  type AppRemoval,
  type AppSaveRequest,
  type AppStarted,
  type AppTask,
  type AppsList,
  APPS_PATH,
  appDeletePath,
  appFilesPath,
  appPath,
  appRemovalPath,
  appRemovePath,
  appTaskPath,
  appUpdatePath,
  CATALOG_PATH,
  catalogEntryPath,
  type TemplateDetails,
  type TemplateSummary,
} from '@laris/shared';
import type { Observable } from 'rxjs';

/** Apps and their templates (docs/plans/acting_as_you.md). Changes are done as the signed-in Linux account. */
@Service()
export class AppsApi {
  private readonly http = inject(HttpClient);

  list(): Observable<AppsList> {
    return this.http.get<AppsList>(APPS_PATH);
  }

  templates(): Observable<TemplateSummary[]> {
    return this.http.get<TemplateSummary[]>(CATALOG_PATH);
  }

  template(id: string): Observable<TemplateDetails> {
    return this.http.get<TemplateDetails>(catalogEntryPath(id));
  }

  checkName(name: string): Observable<AppNameCheck> {
    return this.http.get<AppNameCheck>(APP_NAME_CHECK_PATH, { params: { name } });
  }

  fields(request: AppFieldsRequest): Observable<AppFields> {
    return this.http.post<AppFields>(APP_FIELDS_PATH, request);
  }

  install(request: AppInstallRequest): Observable<AppStarted> {
    return this.http.post<AppStarted>(APPS_PATH, request);
  }

  details(name: string, folder?: string): Observable<AppDetails> {
    return this.http.get<AppDetails>(appPath(name), { params: folder ? { folder } : {} });
  }

  task(name: string, folder: string): Observable<{ task: AppTask | null }> {
    return this.http.get<{ task: AppTask | null }>(appTaskPath(name), { params: { folder } });
  }

  save(name: string, request: AppSaveRequest): Observable<AppStarted> {
    return this.http.put<AppStarted>(appFilesPath(name), request);
  }

  update(name: string, folder: string): Observable<AppStarted> {
    return this.http.post<AppStarted>(appUpdatePath(name), { folder });
  }

  removal(name: string, folder: string): Observable<AppRemoval> {
    return this.http.get<AppRemoval>(appRemovalPath(name), { params: { folder } });
  }

  remove(name: string, folder: string): Observable<AppStarted> {
    return this.http.post<AppStarted>(appRemovePath(name), { folder });
  }

  delete(name: string, request: AppDeleteRequest): Observable<void> {
    return this.http.post<void>(appDeletePath(name), request);
  }
}
