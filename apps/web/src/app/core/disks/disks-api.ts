import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import type { DiskMountedResponse, DiskMountRequest, DisksStatus } from '@laris/shared';
import type { Observable } from 'rxjs';

/** The server's disk endpoints. Live changes arrive through the `disks` topic. */
@Service()
export class DisksApi {
  private readonly http = inject(HttpClient);

  status(): Observable<DisksStatus> {
    return this.http.get<DisksStatus>('/api/disks');
  }

  mount(request: DiskMountRequest): Observable<DiskMountedResponse> {
    return this.http.post<DiskMountedResponse>('/api/disks/mount', request);
  }

  unmount(name: string): Observable<void> {
    return this.http.delete<void>(`/api/disks/${encodeURIComponent(name)}`);
  }
}
