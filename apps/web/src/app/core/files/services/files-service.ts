import { inject, Service } from '@angular/core';
import type { Observable } from 'rxjs';
import { FilesApi } from '../files-api';

/**
 * Files' API calls for the stores. Stateless: every method an Observable, a refusal its error.
 * For now what the uploads need; the Files page store moves over in a later pass.
 */
@Service()
export class FilesService {
  private readonly filesApi = inject(FilesApi);

  /** One file into `folder`: its progress (0–1), complete once it's there. */
  upload(folder: string, file: File, replace: boolean): Observable<number> {
    return this.filesApi.upload(folder, file, replace);
  }
}
