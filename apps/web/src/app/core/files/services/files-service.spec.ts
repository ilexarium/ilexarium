import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of, toArray } from 'rxjs';
import { FilesApi } from '../files-api';
import { FilesService } from './files-service';

describe('FilesService', () => {
  it('uploads one file through the API, with its progress', async () => {
    const api = { upload: vi.fn(() => of(0.5, 1)) };
    TestBed.configureTestingModule({ providers: [{ provide: FilesApi, useValue: api }] });
    const file = new File(['a'], 'a.txt');
    const progress = await firstValueFrom(
      TestBed.inject(FilesService).upload('/srv', file, true).pipe(toArray()),
    );
    expect(progress).toEqual([0.5, 1]);
    expect(api.upload).toHaveBeenCalledWith('/srv', file, true);
  });
});
