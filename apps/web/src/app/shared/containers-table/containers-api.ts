import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import type { ContainerAction } from '@homelab/shared';
import { firstValueFrom } from 'rxjs';

/** The server's container actions. The new state arrives through the `containers` topic. */
@Service()
export class ContainersApi {
  private readonly http = inject(HttpClient);

  /** Resolves once Docker is done (204). */
  act(name: string, action: ContainerAction): Promise<unknown> {
    return firstValueFrom(
      this.http.post(`/api/containers/${encodeURIComponent(name)}/${action}`, null),
    );
  }
}
