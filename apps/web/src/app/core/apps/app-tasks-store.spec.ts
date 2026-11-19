import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { AppStarted, AppTask, BackupsStatus } from '@ilex/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { lastValueFrom, type Observable, of, throwError } from 'rxjs';
import { AuthStore } from '../auth/auth-store';
import { fakeAuthApi, OWNER } from '../auth/testing';
import { BackupsApi } from '../backups/backups-api';
import { BackupsStore } from '../backups/backups-store';
import { LinuxSessionStore } from '../linux/linux-session-store';
import { RealtimeService } from '../realtime/realtime-service';
import { fakeSockets } from '../realtime/testing';
import { AppTasksStore } from './app-tasks-store';
import { AppsApi } from './apps-api';
import { testStarted, testTask } from './testing';

const FOLDER = '/home/anna/apps/music';
const TICKED = { folder: FOLDER, settings: true, folders: [], volumes: ['music_cache'] };
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

// No page anywhere: everything here must run in the global store alone.
async function setup() {
  const auth = fakeAuthApi({ user: OWNER });
  const sockets = fakeSockets();
  const answers: (AppTask | null)[] = [];
  const appsApi = {
    remove: vi.fn((): Observable<AppStarted> => of(testStarted('music', { action: 'down' }))),
    install: vi.fn((): Observable<AppStarted> => of(testStarted('music'))),
    delete: vi.fn(() => of(undefined)),
    task: vi.fn(() => of({ task: answers.shift() ?? null })),
  };
  const backupsApi = { addItem: vi.fn(() => of({})) };
  const asPerson = vi.fn(<T>(action: () => Promise<T>): Promise<T | null> => action());
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
  socket.receive({ event: 'backups:snapshot', data: BACKUPS });
  return { tasks: TestBed.inject(AppTasksStore), appsApi, backupsApi, asPerson, answers };
}

describe('AppTasksStore', () => {
  afterEach(() => vi.restoreAllMocks());

  it('removes: down as the person, then what was ticked deleted, with no page to show it', async () => {
    const { tasks, appsApi, answers } = await setup();
    const success = vi.spyOn(toast, 'success');
    answers.push(testTask({ action: 'down', state: 'succeeded' }));
    const followed$ = await tasks.remove('music', FOLDER, TICKED);
    expect(followed$).not.toBeNull();
    // Nobody subscribes: the store follows it itself.
    await vi.waitFor(() => expect(success).toHaveBeenCalledWith('music was removed.'), {
      timeout: 4000,
    });
    expect(appsApi.remove).toHaveBeenCalledWith('music', FOLDER);
    expect(appsApi.delete).toHaveBeenCalledWith('music', TICKED);
  });

  it('shows the same progress to a page that follows it', async () => {
    const { tasks, answers } = await setup();
    answers.push(testTask({ action: 'down' }));
    answers.push(testTask({ action: 'down', state: 'succeeded' }));
    const followed$ = await tasks.remove('music', FOLDER, null);
    const last = await lastValueFrom(followed$!);
    expect(last).toMatchObject({ task: { state: 'succeeded' }, after: 'done' });
  });

  it('deletes nothing when the down failed', async () => {
    const { tasks, appsApi, answers } = await setup();
    answers.push(testTask({ action: 'down', state: 'failed' }));
    const last = await lastValueFrom((await tasks.remove('music', FOLDER, TICKED))!);
    expect(last).toMatchObject({ task: { state: 'failed' }, after: null });
    expect(appsApi.delete).not.toHaveBeenCalled();
  });

  it('a removal refused at the start: worded in a toast, nothing to show', async () => {
    const { tasks, appsApi } = await setup();
    const error = vi.spyOn(toast, 'error');
    appsApi.remove.mockReturnValueOnce(throwError(() => new Error('refused')));
    expect(await tasks.remove('music', FOLDER, TICKED)).toBeNull();
    expect(error).toHaveBeenCalledWith("Couldn't remove music", expect.anything());
  });

  it('nothing when the Linux sign-in was dismissed', async () => {
    const { tasks, appsApi, asPerson } = await setup();
    asPerson.mockResolvedValueOnce(null);
    expect(await tasks.remove('music', FOLDER, TICKED)).toBeNull();
    expect(appsApi.delete).not.toHaveBeenCalled();
  });

  it('deletes nothing after a sign-out', async () => {
    const { tasks, appsApi, answers } = await setup();
    answers.push(testTask({ action: 'down' }));
    await tasks.remove('music', FOLDER, TICKED);
    await TestBed.inject(AuthStore).logout();
    TestBed.tick();
    answers.push(testTask({ action: 'down', state: 'succeeded' }));
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(appsApi.delete).not.toHaveBeenCalled();
  });

  it('installs, then adds the app to the backups as chosen, with no page to show it', async () => {
    const { tasks, backupsApi, answers } = await setup();
    const success = vi.spyOn(toast, 'success');
    answers.push(testTask({ state: 'succeeded' }));
    const request = { name: 'music', folder: null, template: null, compose: 'x', env: '' };
    const result = await tasks.install(request, { mode: 'live', skip: ['cache'] });
    expect(result?.started.name).toBe('music');
    await vi.waitFor(() => expect(success).toHaveBeenCalledWith('music is installed.'), {
      timeout: 4000,
    });
    expect(backupsApi.addItem).toHaveBeenCalledWith({
      kind: 'app',
      project: 'music',
      folders: [],
      skip: [`${FOLDER}/cache`],
      mode: 'live',
    });
  });

  it('installs without a backup when none was chosen; a refused install throws for the page', async () => {
    const { tasks, appsApi, backupsApi, answers } = await setup();
    answers.push(testTask({ state: 'succeeded' }));
    const request = { name: 'music', folder: null, template: null, compose: 'x', env: '' };
    await lastValueFrom((await tasks.install(request, null))!.followed$);
    expect(backupsApi.addItem).not.toHaveBeenCalled();
    appsApi.install.mockReturnValueOnce(throwError(() => new Error('compose refused')));
    await expect(tasks.install(request, null)).rejects.toThrow('compose refused');
  });
});
