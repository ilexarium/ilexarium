import { inject, Service } from '@angular/core';
import type { Observable } from 'rxjs';
import { FilesApi } from '../files-api';

/** For now what the uploads need; the Files page store moves over in a later pass. */
@Service()
export class FilesService {
  private readonly filesApi = inject(FilesApi);

  /** Its progress (0–1), complete once it's there. */
  upload(folder: string, file: File, replace: boolean, root = false): Observable<number> {
    return this.filesApi.upload(folder, file, replace, root);
  }
}
