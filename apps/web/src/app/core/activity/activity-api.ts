import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import type { ActivityResponse } from '@ilex/shared';
import type { Observable } from 'rxjs';

/** The dashboard's "Recent activity": what was done, backup runs and alerts, newest first. */
@Service()
export class ActivityApi {
  private readonly http = inject(HttpClient);

  recent(): Observable<ActivityResponse> {
    return this.http.get<ActivityResponse>('/api/activity');
  }
}
