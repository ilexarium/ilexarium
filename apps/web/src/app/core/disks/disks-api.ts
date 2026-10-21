import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import type { DiskMountedResponse, DiskMountRequest, DisksStatus } from '@laris/shared';
import { firstValueFrom } from 'rxjs';

/** The server's disk endpoints. Live changes arrive through the `disks` topic. */
@Service()
export class DisksApi {
  private readonly http = inject(HttpClient);

  status(): Promise<DisksStatus> {
    return firstValueFrom(this.http.get<DisksStatus>('/api/disks'));
  }

  mount(request: DiskMountRequest): Promise<DiskMountedResponse> {
    return firstValueFrom(this.http.post<DiskMountedResponse>('/api/disks/mount', request));
  }

  unmount(name: string): Promise<void> {
    return firstValueFrom(this.http.delete<void>(`/api/disks/${encodeURIComponent(name)}`));
  }
}
