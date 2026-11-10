import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import type { HostInfo } from '@ilex/shared';
import type { Observable } from 'rxjs';

@Service()
export class MonitoringApi {
  private readonly http = inject(HttpClient);

  host(): Observable<HostInfo> {
    return this.http.get<HostInfo>('/api/system/host');
  }
}
