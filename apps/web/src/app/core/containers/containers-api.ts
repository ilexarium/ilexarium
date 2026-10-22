import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { type ContainerAction, containerActionPath } from '@laris/shared';
import { firstValueFrom } from 'rxjs';

@Service()
export class ContainersApi {
  private readonly http = inject(HttpClient);

  /** Resolves once Docker is done; the new state arrives through the `containers` topic. */
  act(name: string, action: ContainerAction): Promise<unknown> {
    return firstValueFrom(this.http.post(containerActionPath({ name, action }), null));
  }
}
