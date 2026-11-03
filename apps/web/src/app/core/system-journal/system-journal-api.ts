import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import type { JournalBootsResponse, JournalResponse } from '@laris/shared';
import type { Observable } from 'rxjs';
import type { JournalRequest } from './system-journal.model';

/**
 * The machine's journal, read as the signed-in Linux account or as administrator through its
 * unlocked sudo (docs/plans/system_logs.md).
 */
@Service()
export class SystemJournalApi {
  private readonly http = inject(HttpClient);

  read(request: JournalRequest): Observable<JournalResponse> {
    let params = new HttpParams().set('priority', request.priority);
    if (request.unit) params = params.set('unit', request.unit);
    if (request.boot) params = params.set('boot', request.boot);
    if (request.after) params = params.set('after', request.after);
    if (request.before) params = params.set('before', request.before);
    if (request.administrator) params = params.set('administrator', 'true');
    return this.http.get<JournalResponse>('/api/system/journal', { params });
  }

  boots(administrator: boolean): Observable<JournalBootsResponse> {
    const params = administrator ? new HttpParams().set('administrator', 'true') : undefined;
    return this.http.get<JournalBootsResponse>('/api/system/journal/boots', { params });
  }
}
