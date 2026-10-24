import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import {
  CATALOG_PATH,
  type CatalogEntryDetails,
  catalogEntryPath,
  type CatalogEntrySummary,
  type DeployRequest,
  type DeployResponse,
  type RemoveResponse,
  servicePath,
  SERVICES_PATH,
} from '@laris/shared';
import type { Observable } from 'rxjs';

/** Progress arrives through the `services` topic, not these answers. */
@Service()
export class ServicesApi {
  private readonly http = inject(HttpClient);

  catalog(): Observable<CatalogEntrySummary[]> {
    return this.http.get<CatalogEntrySummary[]>(CATALOG_PATH);
  }

  details(id: string): Observable<CatalogEntryDetails> {
    return this.http.get<CatalogEntryDetails>(catalogEntryPath(id));
  }

  /** 202 once the job started; it runs on. */
  deploy(request: DeployRequest): Observable<DeployResponse> {
    return this.http.post<DeployResponse>(SERVICES_PATH, request);
  }

  remove(serviceId: string): Observable<RemoveResponse> {
    return this.http.delete<RemoveResponse>(servicePath(serviceId));
  }
}
