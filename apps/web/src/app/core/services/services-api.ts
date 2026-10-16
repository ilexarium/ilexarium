import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import type {
  CatalogEntryDetails,
  CatalogEntrySummary,
  DeployRequest,
  DeployResponse,
  RemoveResponse,
  Job,
} from '@homelab/shared';
import { firstValueFrom } from 'rxjs';

/** The URL of a catalog entry's icon (an SVG, only ever shown through <img>). */
export function catalogIconUrl(id: string): string {
  return `/api/catalog/${encodeURIComponent(id)}/icon`;
}

/** The server's catalog and services endpoints. Progress arrives through the `services` topic. */
@Service()
export class ServicesApi {
  private readonly http = inject(HttpClient);

  catalog(): Promise<CatalogEntrySummary[]> {
    return firstValueFrom(this.http.get<CatalogEntrySummary[]>('/api/catalog'));
  }

  details(id: string): Promise<CatalogEntryDetails> {
    return firstValueFrom(
      this.http.get<CatalogEntryDetails>(`/api/catalog/${encodeURIComponent(id)}`),
    );
  }

  /** 202 once the job started; it runs on. */
  deploy(request: DeployRequest): Promise<DeployResponse> {
    return firstValueFrom(this.http.post<DeployResponse>('/api/services', request));
  }

  remove(serviceId: string): Promise<RemoveResponse> {
    return firstValueFrom(
      this.http.delete<RemoveResponse>(`/api/services/${encodeURIComponent(serviceId)}`),
    );
  }

  job(jobId: string): Promise<Job> {
    return firstValueFrom(this.http.get<Job>(`/api/services/jobs/${encodeURIComponent(jobId)}`));
  }
}
