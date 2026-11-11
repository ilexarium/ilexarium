import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import {
  type DockerCleanup,
  type DockerPruneResult,
  type VolumeSizes,
  volumePath,
} from '@ilex/shared';
import type { Observable } from 'rxjs';

/** Docker's unused data, and freeing it. */
@Service()
export class DockerCleanupApi {
  private readonly http = inject(HttpClient);

  overview(): Observable<DockerCleanup> {
    return this.http.get<DockerCleanup>('/api/docker/cleanup');
  }

  /** Slow: Docker walks every volume to count them. */
  volumeSizes(): Observable<VolumeSizes> {
    return this.http.get<VolumeSizes>('/api/docker/cleanup/volume-sizes');
  }

  /** Unused images and the build cache, together. */
  prune(): Observable<DockerPruneResult> {
    return this.http.post<DockerPruneResult>('/api/docker/cleanup/prune', null);
  }

  removeVolume(name: string): Observable<void> {
    return this.http.delete<void>(volumePath(name));
  }
}
