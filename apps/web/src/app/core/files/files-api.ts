import { HttpClient, HttpEventType, HttpParams } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import type { FileList, FileSummary, LinuxSession, LinuxSignInRequest } from '@laris/shared';
import { filter, firstValueFrom, map, type Observable } from 'rxjs';

/** The Linux sign-in and the file explorer's endpoints. */
@Service()
export class FilesApi {
  private readonly http = inject(HttpClient);

  session(): Promise<{ session: LinuxSession | null }> {
    return firstValueFrom(this.http.get<{ session: LinuxSession | null }>('/api/files/session'));
  }

  signIn(request: LinuxSignInRequest): Promise<LinuxSession> {
    return firstValueFrom(this.http.post<LinuxSession>('/api/files/session', request));
  }

  signOut(): Promise<void> {
    return firstValueFrom(this.http.delete<void>('/api/files/session'));
  }

  list(path: string): Promise<FileList> {
    return firstValueFrom(
      this.http.get<FileList>('/api/files/list', { params: new HttpParams().set('path', path) }),
    );
  }

  summary(path: string): Promise<FileSummary> {
    return firstValueFrom(
      this.http.get<FileSummary>('/api/files/summary', {
        params: new HttpParams().set('path', path),
      }),
    );
  }

  /** Where the browser downloads a file from (an attachment: never shown in the page). */
  downloadUrl(path: string): string {
    return `/api/files/download?${new HttpParams().set('path', path).toString()}`;
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

  newFolder(parent: string, name: string): Promise<void> {
    return firstValueFrom(this.http.post<void>('/api/files/folder', { parent, name }));
  }

  rename(from: string, to: string): Promise<void> {
    return firstValueFrom(this.http.post<void>('/api/files/rename', { from, to }));
  }

  delete(path: string): Promise<void> {
    return firstValueFrom(
      this.http.delete<void>('/api/files', { params: new HttpParams().set('path', path) }),
    );
  }
}
