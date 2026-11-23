import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom, type Observable, of, switchMap, throwError } from 'rxjs';
import { BackupsApi } from '../../backups/backups-api';
import { LinuxSessionStore } from '../../linux/linux-session-store';
import { AppsApi } from '../apps-api';
import { testDetails, testStarted, testTask } from '../testing';
import { AppActionsService } from './app-actions-service';

const FOLDER = '/home/anna/apps/music';

function setup() {
  const appsApi = {
    details: vi.fn(() => of(testDetails('music'))),
    task: vi.fn(() => of({ task: testTask({ state: 'succeeded' }) })),
    update: vi.fn(() => of(testStarted('music', { action: 'update' }))),
    remove: vi.fn(() => of(testStarted('music', { action: 'down' }))),
    delete: vi.fn(() => of(undefined)),
    template: vi.fn(() =>
      of({
        template: { id: 'navidrome', version: '2', backup: { mode: 'live', skip: ['cache'] } },
        compose: '',
      }),
    ),
  };
  const backupsApi = {
    addItem: vi.fn(() => of({ id: 'i1' })),
    runNow: vi.fn(() => of({ runId: 'r1' })),
  };
  // Signed in, sudo at hand: the action runs at once (null: the prompt was dismissed).
  const asPerson = vi.fn(<T>(action: () => Observable<T>): Observable<T | null> => action());
  TestBed.configureTestingModule({
    providers: [
      { provide: AppsApi, useValue: appsApi },
      { provide: BackupsApi, useValue: backupsApi },
      { provide: LinuxSessionStore, useValue: { asPerson$: asPerson } },
    ],
  });
  return { service: TestBed.inject(AppActionsService), appsApi, backupsApi, asPerson };
}

describe('AppActionsService', () => {
  it('reads without asking for the Linux sign-in itself', async () => {
    const { service, appsApi, asPerson } = setup();
    await expect(firstValueFrom(service.details('music', FOLDER))).resolves.toMatchObject({
      folder: FOLDER,
    });
    expect(appsApi.details).toHaveBeenCalledWith('music', FOLDER);
    expect(asPerson).not.toHaveBeenCalled();
  });

  it('follows a task to its end', async () => {
    const { service, appsApi } = setup();
    const task = await firstValueFrom(service.followTask('music', FOLDER));
    expect(task.state).toBe('succeeded');
    expect(appsApi.task).toHaveBeenCalledWith('music', FOLDER);
  });

  it('a change goes as the person and answers what the server started', async () => {
    const { service, appsApi, asPerson } = setup();
    await expect(firstValueFrom(service.update('music', FOLDER))).resolves.toMatchObject({
      task: { action: 'update' },
    });
    expect(asPerson).toHaveBeenCalledTimes(1);
    expect(appsApi.update).toHaveBeenCalledWith('music', FOLDER);
  });

  it('the prompt dismissed: null, nothing sent', async () => {
    const { service, appsApi, asPerson } = setup();
    asPerson.mockReturnValueOnce(of(null));
    await expect(firstValueFrom(service.remove('music', FOLDER))).resolves.toBeNull();
    expect(appsApi.remove).not.toHaveBeenCalled();
  });

  it('tried again after the sudo prompt: the request made again', async () => {
    const { service, appsApi, asPerson } = setup();
    // As LinuxSessionStore does after a sudo prompt: the action once more.
    asPerson.mockImplementationOnce(<T>(action: () => Observable<T>) =>
      action().pipe(switchMap(() => action())),
    );
    await firstValueFrom(service.update('music', FOLDER));
    expect(appsApi.update).toHaveBeenCalledTimes(2);
  });

  it('a refusal is its error, for the store to word', async () => {
    const { service, appsApi } = setup();
    appsApi.update.mockReturnValueOnce(
      throwError(() => new HttpErrorResponse({ status: 409, error: { code: 'app_task_running' } })),
    );
    await expect(firstValueFrom(service.update('music', FOLDER))).rejects.toBeInstanceOf(
      HttpErrorResponse,
    );
  });

  it('deletes files as the person: true once deleted', async () => {
    const { service, appsApi } = setup();
    const request = { folder: FOLDER, settings: true, folders: [], volumes: [] };
    await expect(firstValueFrom(service.deleteFiles('music', request))).resolves.toBe(true);
    expect(appsApi.delete).toHaveBeenCalledWith('music', request);
  });

  it('Back up now starts the item’s run as the person', async () => {
    const { service, backupsApi } = setup();
    await expect(firstValueFrom(service.backUpNow('i1'))).resolves.toEqual({ runId: 'r1' });
    expect(backupsApi.runNow).toHaveBeenCalledWith('i1');
  });

  it('adds a templated app with its template’s preset', async () => {
    const { service, appsApi, backupsApi } = setup();
    await firstValueFrom(
      service.addToBackups({
        name: 'music',
        folder: FOLDER,
        template: { id: 'navidrome', version: '2' },
      }),
    );
    expect(appsApi.template).toHaveBeenCalledWith('navidrome');
    expect(backupsApi.addItem).toHaveBeenCalledWith({
      kind: 'app',
      project: 'music',
      folders: [],
      skip: [`${FOLDER}/cache`],
      mode: 'live',
    });
  });

  it('without a template: stopped while backed up, nothing skipped', async () => {
    const { service, appsApi } = setup();
    await expect(
      firstValueFrom(service.appBackupItem({ name: 'music', folder: FOLDER, template: null })),
    ).resolves.toEqual({ kind: 'app', project: 'music', folders: [], skip: [], mode: 'stop' });
    expect(appsApi.template).not.toHaveBeenCalled();
  });

  it('the template unreadable: refused before anything is asked or sent', async () => {
    const { service, appsApi, backupsApi, asPerson } = setup();
    appsApi.template.mockReturnValueOnce(throwError(() => new HttpErrorResponse({ status: 500 })));
    await expect(
      firstValueFrom(
        service.addToBackups({
          name: 'music',
          folder: FOLDER,
          template: { id: 'x', version: '1' },
        }),
      ),
    ).rejects.toBeInstanceOf(HttpErrorResponse);
    expect(asPerson).not.toHaveBeenCalled();
    expect(backupsApi.addItem).not.toHaveBeenCalled();
  });
});
