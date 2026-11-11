import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import {
  type SystemServiceAction,
  type SystemServiceDetails,
  systemServicePath,
  type SystemServicesResponse,
} from '@ilex/shared';
import type { Observable } from 'rxjs';

/**
 * The host's services, read as the signed-in Linux account; started, stopped and restarted
 * through its unlocked sudo.
 */
@Service()
export class SystemServicesApi {
  private readonly http = inject(HttpClient);

  list(): Observable<SystemServicesResponse> {
    return this.http.get<SystemServicesResponse>('/api/system/services');
  }

  details(name: string): Observable<SystemServiceDetails> {
    return this.http.get<SystemServiceDetails>(systemServicePath(name));
  }

  act(name: string, action: SystemServiceAction): Observable<void> {
    return this.http.post<void>(`${systemServicePath(name)}/${action}`, {});
  }
}
