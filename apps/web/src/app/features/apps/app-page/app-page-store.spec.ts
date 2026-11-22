import { HttpErrorResponse } from '@angular/common/http';
import { createEnvironmentInjector, EnvironmentInjector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { AppStarted, AppTask, BackupsStatus } from '@ilex/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { type Observable, of, throwError } from 'rxjs';
import { AppsApi } from '../../../core/apps/apps-api';
import { testApp, testDetails, testStarted, testTask } from '../../../core/apps/testing';
import { AuthStore } from '../../../core/auth/auth-store';
import { fakeAuthApi, OWNER } from '../../../core/auth/testing';
import { BackupsApi } from '../../../core/backups/backups-api';
import { BackupsStore } from '../../../core/backups/backups-store';
import { LinuxSessionStore } from '../../../core/linux/linux-session-store';
import { RealtimeService } from '../../../core/realtime/realtime-service';
import { fakeSockets } from '../../../core/realtime/testing';
import { AppPageStore } from './app-page-store';

const FOLDER = '/home/anna/apps/music';
const ITEM: BackupsStatus['items'][number] = {
  id: '00000000-0000-4000-8000-000000000001',
  kind: 'app',
  project: 'music',
  lastSuccessAt: '2026-11-21T03:00:00.000Z',
  lastStatus: 'ok',
};
const BACKUPS: BackupsStatus = {
  configured: true,
  warnings: [],
  lastSuccessAt: null,
  nextRunAt: null,
  running: null,
  lastRun: null,
  items: [],
  restore: null,
  lastCheck: null,
};

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
    start: vi.fn(() => of(testStarted('music', { action: 'up' }))),
    removal: vi.fn(() =>
      of({
        items: [
          { kind: 'settings', path: FOLDER, bytes: null, outside: false },
          { kind: 'folder', path: `${FOLDER}/data`, bytes: 100, outside: false },
          { kind: 'volume', path: 'music_cache', bytes: null, outside: false },
        ],
      }),
    ),
    remove: vi.fn((): Observable<AppStarted> => of(testStarted('music', { action: 'down' }))),
    delete: vi.fn(() => of(undefined)),
  };
  const backupsApi = {
    addItem: vi.fn(() => of({})),
    runNow: vi.fn(() => of({ runId: '00000000-0000-4000-8000-000000000009' })),
  };
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
  TestBed.inject(RealtimeService).connect();
  const socket = sockets.latest();
  socket.open();
  TestBed.inject(BackupsStore).watch();
  /** The `backups` topic says this. */
  const backups = (change: Partial<BackupsStatus>) =>
    socket.receive({ event: 'backups:snapshot', data: { ...BACKUPS, ...change } });
  // Its own injector, like a page's: destroying it is leaving the page.
  const page = createEnvironmentInjector([AppPageStore], TestBed.inject(EnvironmentInjector));
  const store = page.get(AppPageStore);
  store.open('music', null);
  await vi.waitFor(() => expect(store.details()).not.toBeNull());
  /** The page opened again (a new visit), like coming back to it. */
  const reopen = async () => {
    const again = createEnvironmentInjector([AppPageStore], TestBed.inject(EnvironmentInjector));
    const next = again.get(AppPageStore);
    next.open('music', null);
    await vi.waitFor(() => expect(next.details()).not.toBeNull());
    return { store: next, page: again };
  };
  return { store, page, appsApi, backupsApi, asPerson, answers, reopen, backups };
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

  it('Start for an app without containers: up from its folder as the person, its task followed', async () => {
    const { store, appsApi, asPerson, answers } = await setup();
    appsApi.details.mockReturnValueOnce(
      of(testDetails('music', { app: testApp('music', { state: 'none', containers: [] }) })),
    );
    store.reload();
    await vi.waitFor(() => expect(store.summary()?.state).toBe('none'));
    answers.push(testTask({ action: 'up', state: 'succeeded' }));
    await store.act('start');
    expect(asPerson).toHaveBeenCalled();
    expect(appsApi.start).toHaveBeenCalledWith('music', FOLDER);
    await vi.waitFor(() => expect(store.task()?.state).toBe('succeeded'), { timeout: 4000 });
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
    await store.update();
    expect(appsApi.update).not.toHaveBeenCalled();
    expect(store.task()).toBeNull();
  });

  it('removes: down only, followed to its end — the page stays and reads the files again', async () => {
    const { store, appsApi, answers } = await setup();
    answers.push(testTask({ action: 'down' }), testTask({ action: 'down', state: 'succeeded' }));
    await store.remove();
    expect(appsApi.remove).toHaveBeenCalledWith('music', FOLDER);
    // The server's answer shown at once: the buttons stay locked until the task has ended.
    expect(store.task()).toMatchObject({ action: 'down' });
    expect(store.running()).toBe(true);
    await vi.waitFor(() => expect(store.task()?.state).toBe('succeeded'), { timeout: 4000 });
    await vi.waitFor(() => expect(appsApi.details).toHaveBeenCalledTimes(2));
    // Read again from the folder it had: Docker no longer knows it once removed.
    expect(appsApi.details).toHaveBeenLastCalledWith('music', FOLDER);
    expect(appsApi.removal).not.toHaveBeenCalled();
    expect(appsApi.delete).not.toHaveBeenCalled();
    expect(store.removed()).toBe(false);
  });

  it('a failed down: its output stays, nothing else happens', async () => {
    const { store, appsApi, answers } = await setup();
    answers.push(testTask({ action: 'down', state: 'failed', output: ['error'] }));
    await store.remove();
    await vi.waitFor(() => expect(store.task()?.state).toBe('failed'), { timeout: 4000 });
    expect(appsApi.delete).not.toHaveBeenCalled();
    expect(store.removed()).toBe(false);
  });

  it('its files offered for deletion only without containers', async () => {
    const { store, appsApi } = await setup();
    expect(store.filesOnly()).toBe(false);
    appsApi.details.mockReturnValueOnce(
      of(testDetails('music', { app: testApp('music', { state: 'none', containers: [] }) })),
    );
    store.reload();
    await vi.waitFor(() => expect(store.filesOnly()).toBe(true));
  });

  it('deletes the files ticked; with the settings the app is gone: back to the list', async () => {
    const { store, appsApi, asPerson } = await setup();
    const success = vi.spyOn(toast, 'success');
    await store.openDeletion();
    expect(appsApi.removal).toHaveBeenCalledWith('music', FOLDER);
    const [settings, data] = store.removal()!;
    await store.deleteFiles([settings, data]);
    expect(asPerson).toHaveBeenCalledTimes(2);
    expect(appsApi.delete).toHaveBeenCalledWith('music', {
      folder: FOLDER,
      settings: true,
      folders: [`${FOLDER}/data`],
      volumes: [],
    });
    expect(success).toHaveBeenCalledWith('music: what was ticked was deleted.');
    expect(store.removed()).toBe(true);
  });

  it('without the settings: the files read again, still on the page', async () => {
    const { store, appsApi } = await setup();
    await store.openDeletion();
    const [, , volume] = store.removal()!;
    await store.deleteFiles([volume]);
    expect(appsApi.delete).toHaveBeenCalledWith('music', {
      folder: FOLDER,
      settings: false,
      folders: [],
      volumes: ['music_cache'],
    });
    expect(store.removed()).toBe(false);
    await vi.waitFor(() => expect(appsApi.details).toHaveBeenCalledTimes(2));
  });

  it('a refused deletion: said why, the files read again, still on the page', async () => {
    const { store, appsApi } = await setup();
    const error = vi.spyOn(toast, 'error');
    appsApi.delete.mockReturnValueOnce(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 409,
            error: { message: 'x', code: 'app_has_containers' },
          }),
      ),
    );
    await store.openDeletion();
    await store.deleteFiles([store.removal()![0]]);
    expect(error).toHaveBeenCalledWith("Couldn't delete the files of music", {
      description: 'The app still has containers. Remove it first.',
    });
    expect(store.removed()).toBe(false);
    expect(store.busy()).toBe(false);
    await vi.waitFor(() => expect(appsApi.details).toHaveBeenCalledTimes(2));
  });

  it('opened during a task started elsewhere: follows it to its end, then reads again', async () => {
    const { appsApi, answers, reopen } = await setup();
    // Read once during the task; read again after it, the task has ended.
    appsApi.details.mockReturnValueOnce(
      of(testDetails('music', { task: testTask({ action: 'update' }) })),
    );
    answers.push(testTask({ action: 'update' }));
    const { store } = await reopen();
    expect(store.running()).toBe(true);
    const reads = appsApi.details.mock.calls.length;
    answers.splice(0, answers.length, testTask({ action: 'update', state: 'succeeded' }));
    await vi.waitFor(() => expect(store.task()?.state).toBe('succeeded'), { timeout: 4000 });
    await vi.waitFor(() => expect(appsApi.details.mock.calls.length).toBeGreaterThan(reads));
  });

  it('left during a task: no more polls', async () => {
    const { store, page, appsApi, answers } = await setup();
    answers.push(testTask({ action: 'update' }), testTask({ action: 'update' }));
    await store.update();
    await vi.waitFor(() => expect(appsApi.task).toHaveBeenCalled());
    page.destroy();
    const calls = appsApi.task.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(appsApi.task).toHaveBeenCalledTimes(calls);
  });

  it('another app opened during a task: the old one no longer followed', async () => {
    const { store, appsApi, answers } = await setup();
    answers.push(testTask({ action: 'update' }), testTask({ action: 'update' }));
    await store.update();
    await vi.waitFor(() => expect(appsApi.task).toHaveBeenCalled());
    appsApi.details.mockReturnValue(of(testDetails('wiki')));
    store.open('wiki', null);
    expect(store.task()).toBeNull();
    const calls = appsApi.task.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(appsApi.task).toHaveBeenCalledTimes(calls);
  });

  it('updates as the person and follows the task — no backup first', async () => {
    const { store, appsApi, backupsApi, answers } = await setup();
    answers.push(testTask({ action: 'update', state: 'succeeded', output: ['pulled'] }));
    await store.update();
    expect(appsApi.update).toHaveBeenCalledWith('music', FOLDER);
    expect(backupsApi.runNow).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(store.task()?.state).toBe('succeeded'), { timeout: 4000 });
    expect(store.task()?.output).toContain('pulled');
  });

  it('Back up now: starts the app’s backup as the person and waits for nothing', async () => {
    const { store, appsApi, backupsApi, asPerson, backups } = await setup();
    const info = vi.spyOn(toast, 'info');
    backups({ items: [ITEM] });
    await store.backUpNow();
    expect(asPerson).toHaveBeenCalledTimes(1);
    expect(backupsApi.runNow).toHaveBeenCalledWith(ITEM.id);
    expect(info).toHaveBeenCalledWith("music's backup has started.");
    expect(appsApi.update).not.toHaveBeenCalled();
    expect(store.busy()).toBe(false);
  });

  it('a backup just started here: no update and no second backup, before the topic shows it', async () => {
    const { store, backups } = await setup();
    backups({ items: [ITEM] });
    await store.backUpNow();
    expect(store.appBackingUp()).toBe(true);
    expect(store.backupRunning()).toBe(true);
    backups({
      items: [ITEM],
      lastRun: {
        id: '00000000-0000-4000-8000-000000000009',
        trigger: 'manual',
        itemId: ITEM.id,
        status: 'ok',
        errorCode: null,
        startedAt: '2026-11-22T10:00:00.000Z',
        finishedAt: '2026-11-22T10:01:00.000Z',
        items: [],
      },
    });
    expect(store.appBackingUp()).toBe(false);
    expect(store.backupRunning()).toBe(false);
  });

  it('while its backup runs or waits in the run: no update; another app’s backup: update allowed', async () => {
    const { store, backups } = await setup();
    const run = (itemId: string, state: 'waiting' | 'running' | 'done') => ({
      runId: '00000000-0000-4000-8000-000000000009',
      trigger: 'manual' as const,
      startedAt: '2026-11-22T10:00:00.000Z',
      items: [{ itemId, state, phase: null, result: null }],
      output: [],
    });
    backups({ items: [ITEM], running: run(ITEM.id, 'running') });
    expect(store.appBackingUp()).toBe(true);
    expect(store.backupRunning()).toBe(true);
    backups({ items: [ITEM], running: run(ITEM.id, 'waiting') });
    expect(store.appBackingUp()).toBe(true);
    backups({ items: [ITEM], running: run(ITEM.id, 'done') });
    expect(store.appBackingUp()).toBe(false);
    backups({ items: [ITEM], running: run('00000000-0000-4000-8000-000000000002', 'running') });
    expect(store.appBackingUp()).toBe(false);
    expect(store.backupRunning()).toBe(true);
    backups({ items: [ITEM] });
    expect(store.backupRunning()).toBe(false);
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
