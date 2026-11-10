import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import type { StartUpdateResponse, UpdatesStatus } from '@ilex/shared';
import type { Observable } from 'rxjs';

/** The server's update endpoints. A running update's progress arrives through the `updates` topic. */
@Service()
export class UpdatesApi {
  private readonly http = inject(HttpClient);

  status(): Observable<UpdatesStatus> {
    return this.http.get<UpdatesStatus>('/api/updates');
  }

  check(): Observable<UpdatesStatus> {
    return this.http.post<UpdatesStatus>('/api/updates/check', {});
  }

  setCheckAutomatically(checkAutomatically: boolean): Observable<void> {
    return this.http.put<void>('/api/updates/settings', { checkAutomatically });
  }

  start(version: string): Observable<StartUpdateResponse> {
    return this.http.post<StartUpdateResponse>('/api/updates', { version });
  }
}
