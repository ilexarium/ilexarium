import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import type { ProcessSignalRequest } from '@laris/shared';
import type { Observable } from 'rxjs';

/**
 * Ending a process as the Linux account (another account's through its unlocked sudo). The list
 * itself arrives through the `processes` topic.
 */
@Service()
export class ProcessesApi {
  private readonly http = inject(HttpClient);

  signal(request: ProcessSignalRequest): Observable<void> {
    return this.http.post<void>('/api/processes/signal', request);
  }
}
