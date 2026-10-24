import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { type ContainerAction, containerActionPath } from '@laris/shared';
import type { Observable } from 'rxjs';

@Service()
export class ContainersApi {
  private readonly http = inject(HttpClient);

  /** Resolves once Docker is done; the new state arrives through the `containers` topic. */
  act(name: string, action: ContainerAction): Observable<unknown> {
    return this.http.post(containerActionPath({ name, action }), null);
  }
}
