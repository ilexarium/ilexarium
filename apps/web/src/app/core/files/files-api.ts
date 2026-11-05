import { HttpClient, HttpEventType, HttpParams } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import type {
  FileList,
  FileSummary,
  LinuxSession,
  LinuxSessionAnswer,
  LinuxSignInRequest,
  LinuxSudoRequest,
} from '@laris/shared';
import { filter, map, type Observable } from 'rxjs';
import { STRICT_QUERY_CODEC } from '../http/strict-query.constants';

/** The Linux sign-in (with its sudo) and the file explorer's endpoints. */
@Service()
export class FilesApi {
  private readonly http = inject(HttpClient);

  session(): Observable<LinuxSessionAnswer> {
    return this.http.get<LinuxSessionAnswer>('/api/files/session');
  }

  signIn(request: LinuxSignInRequest): Observable<LinuxSession> {
    return this.http.post<LinuxSession>('/api/files/session', request);
  }

  signOut(): Observable<void> {
    return this.http.delete<void>('/api/files/session');
  }

  /** Unlocks the account's sudo with its password; answers the session with `sudoUntil`. */
  unlockSudo(request: LinuxSudoRequest): Observable<LinuxSession> {
    return this.http.post<LinuxSession>('/api/files/session/sudo', request);
  }

  /** "Lock now": sudo locked; the Linux session stays. */
  lockSudo(): Observable<LinuxSessionAnswer> {
    return this.http.delete<LinuxSessionAnswer>('/api/files/session/sudo');
  }

  list(path: string): Observable<FileList> {
    return this.http.get<FileList>('/api/files/list', {
      params: new HttpParams().set('path', path),
    });
  }

  summary(path: string): Observable<FileSummary> {
    return this.http.get<FileSummary>('/api/files/summary', {
      params: new HttpParams().set('path', path),
    });
  }

  /** Where the browser downloads a file from (an attachment: never shown in the page). */
  downloadUrl(path: string): string {
    return `/api/files/download?${new HttpParams({ encoder: STRICT_QUERY_CODEC }).set('path', path).toString()}`;
  }

  /** Uploads one file; emits its progress (0–1), completes when it's there. */
  upload(folder: string, file: File, replace: boolean): Observable<number> {
    const params = new HttpParams()
      .set('folder', folder)
      .set('name', file.name)
      .set('replace', String(replace));
    return this.http
      .put('/api/files/upload', file, {
        params,
        headers: { 'Content-Type': 'application/octet-stream' },
        reportProgress: true,
        observe: 'events',
      })
      .pipe(
        filter((event) => event.type === HttpEventType.UploadProgress),
        map((event) => (event.total ? event.loaded / event.total : 0)),
      );
  }

  newFolder(parent: string, name: string): Observable<void> {
    return this.http.post<void>('/api/files/folder', { parent, name });
  }

  rename(from: string, to: string): Observable<void> {
    return this.http.post<void>('/api/files/rename', { from, to });
  }

  delete(path: string): Observable<void> {
    return this.http.delete<void>('/api/files', { params: new HttpParams().set('path', path) });
  }
}
