import { HttpErrorResponse } from '@angular/common/http';
import { createEnvironmentInjector, EnvironmentInjector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { AppTask } from '@ilex/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { of, Subject, throwError } from 'rxjs';
import { AppsApi } from '../../../core/apps/apps-api';
import { testDetails, testStarted, testTask } from '../../../core/apps/testing';
import { AuthStore } from '../../../core/auth/auth-store';
import { fakeAuthApi, OWNER } from '../../../core/auth/testing';
import { BackupsApi } from '../../../core/backups/backups-api';
import { LinuxSessionStore } from '../../../core/linux/linux-session-store';
import { fakeSockets } from '../../../core/realtime/testing';
import { AppPageStore } from './app-page-store';

const FOLDER = '/home/anna/apps/music';

async function setup() {
  const auth = fakeAuthApi({ user: OWNER });
  const sockets = fakeSockets();
  // What the task answers next, one per poll.
  const answers: (AppTask | null)[] = [];
  const appsApi = {
    templates: vi.fn(() => of([])),
    template: vi.fn(() =>
      of({
        template: { id: 'navidrome', version: '2', backup: { mode: 'live', skip: ['cache'] } },
        compose: '',
      }),
    ),
    details: vi.fn(() => of(testDetails('music'))),
    task: vi.fn(() => of({ task: answers.shift() ?? null })),
    save: vi.fn(() => of(testStarted('music'))),
    update: vi.fn(() => of(testStarted('music', { action: 'update' }))),
    removal: vi.fn(() =>
      of({
        items: [
          { kind: 'settings', path: FOLDER, bytes: null, outside: false },
          { kind: 'folder', path: `${FOLDER}/data`, bytes: 100, outside: false },
          { kind: 'volume', path: 'music_cache', bytes: null, outside: false },
        ],
      }),
    ),
    remove: vi.fn(() => of(testStarted('music', { action: 'down' }))),
    delete: vi.fn(() => of(undefined)),
  };
  const backupsApi = { addItem: vi.fn(() => of({})) };
  // Signed in to Linux with sudo at hand: every action goes straight through.
  const asPerson = vi.fn(<T>(action: () => Promise<T>) => action());
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: 'login', children: [] }]),
      auth.provider,
      sockets.provider,
      { provide: AppsApi, useValue: appsApi },
      { provide: BackupsApi, useValue: backupsApi },
      { provide: LinuxSessionStore, useValue: { asPerson, check: vi.fn() } },
    ],
  });
  await TestBed.inject(AuthStore).load();
  // Its own injector, like a page's: destroying it is leaving the page.
  const page = createEnvironmentInjector([AppPageStore], TestBed.inject(EnvironmentInjector));
  const store = page.get(AppPageStore);
  store.open('music', null);
  await vi.waitFor(() => expect(store.details()).not.toBeNull());
  return { store, page, appsApi, backupsApi, asPerson, answers };
}

describe('AppPageStore', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads the files and their form; edits show as changes until saved', async () => {
    const { store } = await setup();
    expect(store.folder()).toBe(FOLDER);
    expect(store.values().get('VERSION')).toBe('1.27');
    expect(store.changed()).toBe(false);
    store.setValue('VERSION', '1.28');
    expect(store.env()).toBe('VERSION=1.28\n');
    expect(store.changed()).toBe(true);
  });

  it('says why it couldn’t be read', async () => {
    const { store, appsApi } = await setup();
    appsApi.details.mockReturnValueOnce(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 403,
            error: { message: 'x', code: 'linux_session_required' },
          }),
      ),
    );
    store.reload();
    await vi.waitFor(() => expect(store.loadError()).toBe('linux_session_required'));
  });

  it('saves as the person with the hash read, follows the task to its end, then reads again', async () => {
    const { store, appsApi, asPerson, answers } = await setup();
    store.setValue('VERSION', '1.28');
    answers.push(testTask({ output: ['pulling'] }));
    answers.push(testTask({ state: 'succeeded', output: ['pulling', 'started'] }));
    await store.save();
    expect(asPerson).toHaveBeenCalled();
    expect(appsApi.save).toHaveBeenCalledWith('music', {
      folder: FOLDER,
      compose: testDetails('music').compose,
      env: 'VERSION=1.28\n',
      hash: 'h1',
      overwrite: false,
    });
    await vi.waitFor(() => expect(store.task()?.state).toBe('succeeded'), { timeout: 4000 });
    // Each answer is the end of the output, all of it: shown as it is.
    expect(store.task()?.output).toEqual(['pulling', 'started']);
    expect(appsApi.task).toHaveBeenLastCalledWith('music', FOLDER);
    await vi.waitFor(() => expect(appsApi.details).toHaveBeenCalledTimes(2));
  });

  it('files changed on disk meanwhile: a conflict to settle, then overwritten when asked', async () => {
    const { store, appsApi } = await setup();
    appsApi.save.mockReturnValueOnce(
      throwError(
        () =>
          new HttpErrorResponse({ status: 409, error: { message: 'x', code: 'changed_on_disk' } }),
      ),
    );
    const error = vi.spyOn(toast, 'error');
    await store.save();
    expect(store.conflict()).toBe(true);
    expect(error).not.toHaveBeenCalled();
    await store.save(true);
    expect(store.conflict()).toBe(false);
    expect(appsApi.save).toHaveBeenLastCalledWith(
      'music',
      expect.objectContaining({ overwrite: true }),
    );
  });

  it('nothing happens when the Linux sign-in is closed', async () => {
    const { store, appsApi, asPerson } = await setup();
    asPerson.mockResolvedValueOnce(null);
    await store.update(false);
    expect(appsApi.update).not.toHaveBeenCalled();
    expect(store.task()).toBeNull();
  });

  it('removes: down first, then only what was ticked deleted — the app gone from the page', async () => {
    const { store, appsApi, answers } = await setup();
    const success = vi.spyOn(toast, 'success');
    await store.openRemoval();
    const [settings, data] = store.removal()!;
    answers.push(testTask({ action: 'down', state: 'succeeded' }));
    await store.remove([settings, data]);
    await vi.waitFor(() => expect(store.removed()).toBe(true), { timeout: 4000 });
    expect(appsApi.remove).toHaveBeenCalledWith('music', FOLDER);
    expect(appsApi.delete).toHaveBeenCalledWith('music', {
      folder: FOLDER,
      settings: true,
      folders: [`${FOLDER}/data`],
      volumes: [],
    });
    expect(success).toHaveBeenCalledWith('music was removed.');
  });

  it('still deletes what was ticked when the page is left during the removal', async () => {
    const { store, page, appsApi, answers } = await setup();
    const success = vi.spyOn(toast, 'success');
    await store.openRemoval();
    const [, , volume] = store.removal()!;
    answers.push(testTask({ action: 'down' }));
    answers.push(testTask({ action: 'down', state: 'succeeded' }));
    await store.remove([volume]);
    page.destroy();
    await vi.waitFor(() => expect(success).toHaveBeenCalledWith('music was removed.'), {
      timeout: 4000,
    });
    expect(appsApi.delete).toHaveBeenCalledWith('music', {
      folder: FOLDER,
      settings: false,
      folders: [],
      volumes: ['music_cache'],
    });
  });

  it('stays busy until the deletion after a removal is through', async () => {
    const { store, appsApi, answers } = await setup();
    const deleted = new Subject<undefined>();
    appsApi.delete.mockReturnValueOnce(deleted);
    await store.openRemoval();
    const [settings] = store.removal()!;
    answers.push(testTask({ action: 'down', state: 'succeeded' }));
    await store.remove([settings]);
    await vi.waitFor(() => expect(appsApi.delete).toHaveBeenCalled(), { timeout: 4000 });
    expect(store.busy()).toBe(true);
    deleted.next(undefined);
    deleted.complete();
    await vi.waitFor(() => expect(store.removed()).toBe(true));
    expect(store.busy()).toBe(false);
  });

  it('deletes nothing after a sign-out, even with the page still open', async () => {
    const { store, appsApi, answers } = await setup();
    await store.openRemoval();
    const [settings] = store.removal()!;
    answers.push(testTask({ action: 'down' }));
    await store.remove([settings]);
    await TestBed.inject(AuthStore).logout();
    TestBed.tick();
    answers.push(testTask({ action: 'down', state: 'succeeded' }));
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(appsApi.delete).not.toHaveBeenCalled();
  });

  it('a failed down deletes nothing', async () => {
    const { store, appsApi, answers } = await setup();
    await store.openRemoval();
    answers.push(testTask({ action: 'down', state: 'failed', output: ['error'] }));
    await store.remove(store.removal()!);
    await vi.waitFor(() => expect(store.task()?.state).toBe('failed'), { timeout: 4000 });
    expect(appsApi.delete).not.toHaveBeenCalled();
    expect(store.removed()).toBe(false);
  });

  it('updates as the person and follows the task', async () => {
    const { store, appsApi, answers } = await setup();
    answers.push(testTask({ action: 'update', state: 'succeeded', output: ['pulled'] }));
    await store.update(false);
    expect(appsApi.update).toHaveBeenCalledWith('music', FOLDER);
    await vi.waitFor(() => expect(store.task()?.state).toBe('succeeded'), { timeout: 4000 });
    expect(store.task()?.output).toContain('pulled');
  });

  it('adds a templated app with its template’s preset', async () => {
    const { store, appsApi, backupsApi } = await setup();
    appsApi.details.mockReturnValueOnce(
      of(testDetails('music', { template: { id: 'navidrome', version: '2' } })),
    );
    store.reload();
    await vi.waitFor(() => expect(store.details()?.template).not.toBeNull());
    await store.addToBackups();
    expect(appsApi.template).toHaveBeenCalledWith('navidrome');
    expect(backupsApi.addItem).toHaveBeenCalledWith({
      kind: 'app',
      project: 'music',
      folders: [],
      skip: [`${FOLDER}/cache`],
      mode: 'live',
    });
  });

  it('adds nothing when the template’s preset can’t be read', async () => {
    const { store, appsApi, backupsApi } = await setup();
    const error = vi.spyOn(toast, 'error');
    appsApi.details.mockReturnValueOnce(
      of(testDetails('music', { template: { id: 'navidrome', version: '2' } })),
    );
    store.reload();
    await vi.waitFor(() => expect(store.details()?.template).not.toBeNull());
    appsApi.template.mockReturnValueOnce(throwError(() => new HttpErrorResponse({ status: 500 })));
    await store.addToBackups();
    expect(backupsApi.addItem).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });

  it('adds the app to the backups as the person', async () => {
    const { store, backupsApi } = await setup();
    await store.addToBackups();
    expect(backupsApi.addItem).toHaveBeenCalledWith({
      kind: 'app',
      project: 'music',
      folders: [],
      skip: [],
      mode: 'stop',
    });
  });
});
