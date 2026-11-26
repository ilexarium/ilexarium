import { HttpClient, HttpEventType, HttpParams } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import type {
  FileList,
  FileSummary,
  LinuxSession,
  LinuxSessionAnswer,
  LinuxSignInRequest,
  LinuxSudoRequest,
} from '@ilex/shared';
import { filter, map, type Observable } from 'rxjs';
import { STRICT_QUERY_CODEC } from '../http/strict-query.constants';

/** Files as administrator: `root=true` only when asked (absent, the account's own). */
function withRoot(params: HttpParams, root: boolean): HttpParams {
  return root ? params.set('root', 'true') : params;
}

/**
 * The Linux sign-in (with its sudo) and the file explorer's endpoints; with `root`, the explorer's
 * requests are done as root through the unlocked sudo.
 */
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

  list(path: string, root = false): Observable<FileList> {
    return this.http.get<FileList>('/api/files/list', {
      params: withRoot(new HttpParams().set('path', path), root),
    });
  }

  summary(path: string, root = false): Observable<FileSummary> {
    return this.http.get<FileSummary>('/api/files/summary', {
      params: withRoot(new HttpParams().set('path', path), root),
    });
  }

  /** Where the browser downloads a file from (an attachment: never shown in the page). */
  downloadUrl(path: string, root = false): string {
    const params = new HttpParams({ encoder: STRICT_QUERY_CODEC }).set('path', path);
    return `/api/files/download?${withRoot(params, root).toString()}`;
  }

  /** Uploads one file; emits its progress (0–1), completes when it's there. */
  upload(folder: string, file: File, replace: boolean, root = false): Observable<number> {
    const params = withRoot(
      new HttpParams().set('folder', folder).set('name', file.name).set('replace', String(replace)),
      root,
    );
    return this.http
      .put('/api/files/upload', file, {
        params,
        headers: { 'Content-Type': 'application/octet-stream' },
        reportUploadProgress: true,
        observe: 'events',
      })
      .pipe(
        filter((event) => event.type === HttpEventType.UploadProgress),
        map((event) => (event.total ? event.loaded / event.total : 0)),
      );
  }

  newFolder(parent: string, name: string, root = false): Observable<void> {
    return this.http.post<void>('/api/files/folder', { parent, name, ...(root && { root }) });
  }

  rename(from: string, to: string, root = false): Observable<void> {
    return this.http.post<void>('/api/files/rename', { from, to, ...(root && { root }) });
  }

  delete(path: string, root = false): Observable<void> {
    return this.http.delete<void>('/api/files', {
      params: withRoot(new HttpParams().set('path', path), root),
    });
  }
}
