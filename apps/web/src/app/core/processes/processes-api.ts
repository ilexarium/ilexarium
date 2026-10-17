import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import type { ProcessSignalRequest } from '@homelab/shared';
import { firstValueFrom } from 'rxjs';

/** Ending a process. The list itself arrives through the `processes` topic. */
@Service()
export class ProcessesApi {
  private readonly http = inject(HttpClient);

  signal(request: ProcessSignalRequest): Promise<void> {
    return firstValueFrom(this.http.post<void>('/api/processes/signal', request));
  }
}
