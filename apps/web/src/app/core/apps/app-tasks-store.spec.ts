import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { APP_LIMITS, type AppStarted, type AppTask, type BackupsStatus } from '@ilex/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { type Observable, of, Subject, throwError } from 'rxjs';
import { AuthStore } from '../auth/auth-store';
import { fakeAuthApi, OWNER } from '../auth/testing';
import { BackupsApi } from '../backups/backups-api';
import { BackupsStore } from '../backups/backups-store';
import { LinuxSessionStore } from '../linux/linux-session-store';
import { RealtimeService } from '../realtime/realtime-service';
import { fakeSockets } from '../realtime/testing';
import { AppTasksStore, taskEnded } from './app-tasks-store';
import { AppsApi } from './apps-api';
import { TASK_POLL_GIVE_UP } from './app-tasks-store.constants';
import { testStarted, testTask } from './testing';

const FOLDER = '/home/anna/apps/music';
const TICKED = { folder: FOLDER, settings: true, folders: [], volumes: ['music_cache'] };
const INSTALL = { name: 'music', folder: null, template: null, compose: 'x', env: '' };
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
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// No page anywhere: everything here must run in the global store alone.
async function setup() {
  const auth = fakeAuthApi({ user: OWNER });
  const sockets = fakeSockets();
  // What the task answers next, one per poll (the last one repeats).
  const answers: (AppTask | null)[] = [];
  const started = (action: AppTask['action']): Observable<AppStarted> =>
    of(testStarted('music', { action }));
  const appsApi = {
    save: vi.fn(() => started('up')),
    update: vi.fn(() => started('update')),
    start: vi.fn(() => started('up')),
    remove: vi.fn(() => started('down')),
    install: vi.fn(() => started('up')),
    delete: vi.fn(() => of(undefined)),
    task: vi.fn(() => of({ task: answers.length > 1 ? answers.shift()! : (answers[0] ?? null) })),
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
  const tasks = TestBed.inject(AppTasksStore);
  const entry = () => tasks.tasks()['music'];
  return { tasks, entry, appsApi, backupsApi, asPerson, answers };
}

describe('AppTasksStore', () => {
  afterEach(() => vi.restoreAllMocks());

  it('removes: down as the person, then what was ticked deleted — its state as it goes', async () => {
    const { tasks, entry, appsApi, answers } = await setup();
    const success = vi.spyOn(toast, 'success');
    answers.push(testTask({ action: 'down' }), testTask({ action: 'down', state: 'succeeded' }));
    await tasks.remove('music', FOLDER, TICKED);
    // The server's answer at once.
    expect(entry()).toMatchObject({ kind: 'remove', task: { action: 'down', state: 'running' } });
    await vi.waitFor(() => expect(entry()?.after).toBe('done'), { timeout: 4000 });
    expect(taskEnded(entry())).toBe(true);
    expect(appsApi.remove).toHaveBeenCalledWith('music', FOLDER);
    expect(appsApi.delete).toHaveBeenCalledTimes(1);
    expect(appsApi.delete).toHaveBeenCalledWith('music', TICKED);
    expect(success).toHaveBeenCalledWith('music was removed.');
  });

  it('deletes nothing when the down failed', async () => {
    const { tasks, entry, appsApi, answers } = await setup();
    answers.push(testTask({ action: 'down', state: 'failed' }));
    await tasks.remove('music', FOLDER, TICKED);
    await vi.waitFor(() => expect(entry()?.task.state).toBe('failed'));
    expect(entry()?.after).toBeNull();
    expect(appsApi.delete).not.toHaveBeenCalled();
  });

  it('a refused start throws for the page to word, and leaves no entry', async () => {
    const { tasks, entry, appsApi } = await setup();
    appsApi.remove.mockReturnValueOnce(throwError(() => new Error('refused')));
    await expect(tasks.remove('music', FOLDER, TICKED)).rejects.toThrow('refused');
    expect(entry()).toBeUndefined();
    expect(appsApi.delete).not.toHaveBeenCalled();
  });

  it('nothing when the Linux sign-in was dismissed', async () => {
    const { tasks, entry, asPerson } = await setup();
    asPerson.mockResolvedValueOnce(null);
    expect(await tasks.update('music', FOLDER)).toBeNull();
    expect(entry()).toBeUndefined();
  });

  it('one task per app: a new one replaces the entry and stops the old one’s poll', async () => {
    const { tasks, entry, appsApi, answers } = await setup();
    answers.push(testTask({ action: 'down' }));
    await tasks.remove('music', FOLDER, TICKED);
    const first = entry()!.id;
    await tasks.update('music', FOLDER);
    expect(entry()).toMatchObject({ kind: 'update' });
    expect(entry()!.id).toBeGreaterThan(first);
    // The removal ending now changes nothing: its poll is gone, its deletion never runs.
    answers.splice(0, answers.length, testTask({ action: 'update', state: 'succeeded' }));
    await vi.waitFor(() => expect(entry()?.task.state).toBe('succeeded'), { timeout: 4000 });
    expect(entry()).toMatchObject({ kind: 'update', after: null });
    expect(appsApi.delete).not.toHaveBeenCalled();
  });

  it('never follows a task whose start answered after a sign-out', async () => {
    const { tasks, entry, appsApi } = await setup();
    const started = new Subject<AppStarted>();
    appsApi.remove.mockReturnValueOnce(started);
    const removing = tasks.remove('music', FOLDER, TICKED);
    await TestBed.inject(AuthStore).logout();
    TestBed.tick();
    started.next(testStarted('music', { action: 'down' }));
    started.complete();
    expect(await removing).toBeNull();
    expect(entry()).toBeUndefined();
    await wait(1500);
    expect(appsApi.task).not.toHaveBeenCalled();
  });

  it('a sign-out empties the state and stops every poll', async () => {
    const { tasks, appsApi, answers } = await setup();
    answers.push(testTask({ action: 'down' }));
    await tasks.remove('music', FOLDER, TICKED);
    await vi.waitFor(() => expect(appsApi.task).toHaveBeenCalled());
    await TestBed.inject(AuthStore).logout();
    TestBed.tick();
    expect(tasks.tasks()).toEqual({});
    const polls = appsApi.task.mock.calls.length;
    answers.splice(0, answers.length, testTask({ action: 'down', state: 'succeeded' }));
    await wait(1500);
    expect(appsApi.task.mock.calls.length).toBe(polls);
    expect(appsApi.delete).not.toHaveBeenCalled();
  });

  it('installs, then adds the app to the backups as chosen', async () => {
    const { tasks, entry, backupsApi, answers } = await setup();
    const success = vi.spyOn(toast, 'success');
    answers.push(testTask({ state: 'succeeded' }));
    await tasks.install(INSTALL, { mode: 'live', skip: ['cache'] });
    await vi.waitFor(() => expect(entry()?.after).toBe('done'), { timeout: 4000 });
    expect(entry()?.kind).toBe('install');
    expect(backupsApi.addItem).toHaveBeenCalledWith({
      kind: 'app',
      project: 'music',
      folders: [],
      skip: [`${FOLDER}/cache`],
      mode: 'live',
    });
    expect(success).toHaveBeenCalledWith('music is installed.');
  });

  it('installs without a backup when none was chosen; a refused install throws', async () => {
    const { tasks, entry, appsApi, backupsApi, answers } = await setup();
    answers.push(testTask({ state: 'succeeded' }));
    await tasks.install(INSTALL, null);
    await vi.waitFor(() => expect(entry()?.after).toBe('done'), { timeout: 4000 });
    expect(backupsApi.addItem).not.toHaveBeenCalled();
    appsApi.install.mockReturnValueOnce(throwError(() => new Error('compose refused')));
    await expect(tasks.install(INSTALL, null)).rejects.toThrow('compose refused');
  });

  it('a card’s start says it started and how it ended', async () => {
    const { tasks, entry, answers } = await setup();
    const info = vi.spyOn(toast, 'info');
    const success = vi.spyOn(toast, 'success');
    const error = vi.spyOn(toast, 'error');
    answers.push(testTask({ state: 'succeeded' }));
    await tasks.start('music', FOLDER, true);
    expect(info).toHaveBeenCalledWith('Starting music…');
    await vi.waitFor(() => expect(success).toHaveBeenCalledWith('music started'), {
      timeout: 4000,
    });
    answers.splice(0, answers.length, testTask({ state: 'failed' }));
    await tasks.start('music', FOLDER, true);
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith("Couldn't start music"), {
      timeout: 4000,
    });
    expect(entry()?.task.state).toBe('failed');
  });

  it('the app page’s start says nothing: the page shows the output', async () => {
    const { tasks, entry, answers } = await setup();
    const info = vi.spyOn(toast, 'info');
    const success = vi.spyOn(toast, 'success');
    answers.push(testTask({ state: 'succeeded' }));
    await tasks.start('music', FOLDER);
    await vi.waitFor(() => expect(entry()?.task.state).toBe('succeeded'), { timeout: 4000 });
    expect(info).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
  });

  it('a card’s start that was interrupted says it failed too', async () => {
    const { tasks, answers } = await setup();
    const error = vi.spyOn(toast, 'error');
    answers.push(testTask({ state: 'interrupted' }));
    await tasks.start('music', FOLDER, true);
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith("Couldn't start music"), {
      timeout: 4000,
    });
  });

  it('a second step waiting at the sign-in when someone signs out sends nothing', async () => {
    const { tasks, entry, appsApi, asPerson, answers } = await setup();
    answers.push(testTask({ action: 'down', state: 'succeeded' }));
    // The first call starts the removal; at the second (the deletion's) a sign-out comes first.
    asPerson.mockImplementationOnce((action) => action());
    asPerson.mockImplementationOnce(async (action) => {
      await TestBed.inject(AuthStore).logout();
      TestBed.tick();
      return action();
    });
    await tasks.remove('music', FOLDER, TICKED);
    await vi.waitFor(() => expect(asPerson).toHaveBeenCalledTimes(2), { timeout: 4000 });
    await wait(50);
    expect(appsApi.delete).not.toHaveBeenCalled();
    expect(entry()).toBeUndefined();
  });

  it('watches nothing once signed out', async () => {
    const { tasks, entry } = await setup();
    await TestBed.inject(AuthStore).logout();
    TestBed.tick();
    tasks.watch('music', FOLDER, testTask({ action: 'update' }));
    expect(entry()).toBeUndefined();
  });

  it('stops asking after polls in a row without an answer, and drops the entry', async () => {
    const { tasks, entry, appsApi } = await setup();
    vi.useFakeTimers();
    try {
      appsApi.task.mockImplementation(() => throwError(() => new Error('403')));
      await tasks.update('music', FOLDER);
      expect(entry()).toBeDefined();
      await vi.advanceTimersByTimeAsync(APP_LIMITS.taskPollMs * (TASK_POLL_GIVE_UP + 2));
      expect(appsApi.task).toHaveBeenCalledTimes(TASK_POLL_GIVE_UP);
      expect(entry()).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('an answer in between starts the count again', async () => {
    const { tasks, entry, appsApi } = await setup();
    vi.useFakeTimers();
    try {
      let polls = 0;
      appsApi.task.mockImplementation(() =>
        ++polls === TASK_POLL_GIVE_UP - 1
          ? of({ task: testTask({ action: 'update' }) })
          : throwError(() => new Error('403')),
      );
      await tasks.update('music', FOLDER);
      await vi.advanceTimersByTimeAsync(APP_LIMITS.taskPollMs * (TASK_POLL_GIVE_UP + 5));
      expect(entry()).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('watches a task found running, once; a finished one not at all', async () => {
    const { tasks, entry, appsApi, answers } = await setup();
    tasks.watch('music', FOLDER, testTask({ state: 'succeeded' }));
    expect(entry()).toBeUndefined();
    answers.push(testTask({ action: 'update' }));
    tasks.watch('music', FOLDER, testTask({ action: 'update' }));
    const id = entry()!.id;
    expect(entry()).toMatchObject({ kind: 'watched', task: { state: 'running' } });
    tasks.watch('music', FOLDER, testTask({ action: 'update' }));
    expect(entry()!.id).toBe(id);
    answers.splice(0, answers.length, testTask({ action: 'update', state: 'succeeded' }));
    await vi.waitFor(() => expect(entry()?.task.state).toBe('succeeded'), { timeout: 4000 });
    expect(appsApi.task).toHaveBeenCalledWith('music', FOLDER);
  });
});
