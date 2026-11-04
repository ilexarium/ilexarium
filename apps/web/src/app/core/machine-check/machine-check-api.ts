import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import type { PersonCheck } from '@laris/shared';
import type { Observable } from 'rxjs';

/** The machine check's steps done as the signed-in Linux account (docs/plans/machine_check.md). */
@Service()
export class MachineCheckApi {
  private readonly http = inject(HttpClient);

  person(): Observable<PersonCheck> {
    return this.http.post<PersonCheck>('/api/machine-check/person', {});
  }
}
