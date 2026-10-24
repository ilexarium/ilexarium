import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import type { HostInfo } from '@laris/shared';
import { firstValueFrom } from 'rxjs';

/** The server's machine info; its live values come through the `system` topic. */
@Service()
export class MonitoringApi {
  private readonly http = inject(HttpClient);

  host(): Promise<HostInfo> {
    return firstValueFrom(this.http.get<HostInfo>('/api/system/host'));
  }
}
