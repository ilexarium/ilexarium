import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { LinuxSession } from '@ilex/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { of, Subject, throwError } from 'rxjs';
import { AuthStore } from '../auth/auth-store';
import { fakeAuthApi, OWNER } from '../auth/testing';
import { LinuxSessionStore } from '../linux/linux-session-store';
import { FilesApi } from './files-api';
import { UploadsStore } from './uploads-store';

const ANNA: LinuxSession = { username: 'anna', home: '/home/anna', uid: 1500, sudoUntil: null };
const httpError = (status: number, code: string) =>
  new HttpErrorResponse({ status, error: { message: 'x', code } });
const file = (name: string) => new File([name], name);

async function setup() {
  const auth = fakeAuthApi({ user: OWNER });
  const api = {
    session: vi.fn(() => of({ session: ANNA })),
    upload: vi.fn((_folder: string, _file: File, _replace: boolean) => of(0.5, 1)),
  };
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: 'login', children: [] }]),
      auth.provider,
      { provide: FilesApi, useValue: api },
    ],
  });
  await TestBed.inject(AuthStore).load();
  const store = TestBed.inject(UploadsStore);
  const finished: string[] = [];
  store.finished$.subscribe((folder) => finished.push(folder));
  const states = () => store.uploads().map((u) => [u.name, u.state]);
  return { api, store, finished, states };
}

describe('UploadsStore', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uploads batch after batch, file after file; later files are listed as waiting at once', async () => {
    const { api, store, states } = await setup();
    const first = new Subject<number>();
    api.upload.mockReturnValueOnce(first);
    const [a, b, c] = [file('a.txt'), file('b.txt'), file('c.txt')];
    store.upload({ folder: '/home/anna', files: [a, b], replace: false });
    store.upload({ folder: '/srv/music', files: [c], replace: false });
    expect(api.upload).toHaveBeenCalledTimes(1);
    expect(states()).toEqual([
      ['a.txt', 'uploading'],
      ['b.txt', 'waiting'],
      ['c.txt', 'waiting'],
    ]);
    expect(store.running()).toBe(true);
    expect(store.position()).toEqual({ current: 1, total: 3 });
    first.next(0.4);
    expect(store.uploads()[0].progress).toBe(0.4);
    first.complete();
    expect(api.upload.mock.calls).toEqual([
      ['/home/anna', a, false, false],
      ['/home/anna', b, false, false],
      ['/srv/music', c, false, false],
    ]);
    expect(states()).toEqual([
      ['a.txt', 'done'],
      ['b.txt', 'done'],
      ['c.txt', 'done'],
    ]);
    expect(store.running()).toBe(false);
  });

  it('as root: written as root, and a taken name replaced as root too', async () => {
    const { store, api } = await setup();
    const taken = file('hosts');
    api.upload.mockReturnValueOnce(throwError(() => httpError(409, 'file_exists')));
    store.upload({ folder: '/etc', files: [taken], replace: false, root: true });
    expect(api.upload).toHaveBeenLastCalledWith('/etc', taken, false, true);
    store.answerClashes(true);
    expect(api.upload).toHaveBeenLastCalledWith('/etc', taken, true, true);
  });

  it('says which folder each batch finished in', async () => {
    const { store, finished } = await setup();
    store.upload({ folder: '/home/anna', files: [file('a.txt')], replace: false });
    store.upload({ folder: '/srv', files: [file('b.txt')], replace: false });
    expect(finished).toEqual(['/home/anna', '/srv']);
  });

  it('a taken name: asked about, not listed; Replace uploads it again into the folder asked about', async () => {
    const { api, store, finished } = await setup();
    api.upload.mockReturnValueOnce(throwError(() => httpError(409, 'file_exists')));
    const notes = file('notes.txt');
    store.upload({ folder: '/home/anna', files: [notes], replace: false });
    expect(store.clashes()).toEqual([{ folder: '/home/anna', file: notes, root: false }]);
    expect(store.uploads()).toEqual([]);
    expect(finished).toEqual([]);
    store.answerClashes(true);
    expect(store.clashes()).toEqual([]);
    expect(api.upload).toHaveBeenLastCalledWith('/home/anna', notes, true, false);
    expect(finished).toEqual(['/home/anna']);
  });

  it('taken names from two batches in two folders: one question, each replaced where it was', async () => {
    const { api, store } = await setup();
    api.upload.mockReturnValue(throwError(() => httpError(409, 'file_exists')));
    const [one, two] = [file('one.txt'), file('two.txt')];
    store.upload({ folder: '/home/anna', files: [one], replace: false });
    store.upload({ folder: '/srv', files: [two], replace: false });
    expect(store.clashes().map((c) => c.file)).toEqual([one, two]);
    api.upload.mockReturnValue(of(1));
    store.answerClashes(true);
    expect(api.upload).toHaveBeenCalledWith('/home/anna', one, true, false);
    expect(api.upload).toHaveBeenCalledWith('/srv', two, true, false);
  });

  it('kept: nothing more uploaded', async () => {
    const { api, store } = await setup();
    api.upload.mockReturnValueOnce(throwError(() => httpError(409, 'file_exists')));
    store.upload({ folder: '/home/anna', files: [file('notes.txt')], replace: false });
    store.answerClashes(false);
    expect(store.clashes()).toEqual([]);
    expect(api.upload).toHaveBeenCalledTimes(1);
  });

  it('a refused file: failed, with why in a toast; the next one still goes', async () => {
    const { api, store, states } = await setup();
    const error = vi.spyOn(toast, 'error');
    api.upload.mockReturnValueOnce(throwError(() => httpError(403, 'permission_denied')));
    store.upload({ folder: '/', files: [file('a.txt'), file('b.txt')], replace: false });
    expect(states()).toEqual([
      ['a.txt', 'failed'],
      ['b.txt', 'done'],
    ]);
    expect(error).toHaveBeenCalledWith('a.txt wasn’t uploaded', {
      description: 'Linux doesn’t allow this account to do that.',
    });
  });

  it('a Linux session that ended: one toast, the session gone, the rest not sent', async () => {
    const { api, store, finished } = await setup();
    const error = vi.spyOn(toast, 'error');
    const linuxSessionStore = TestBed.inject(LinuxSessionStore);
    linuxSessionStore.check();
    await vi.waitFor(() => expect(linuxSessionStore.session()).toEqual(ANNA));
    const answer = new Subject<number>();
    api.upload.mockReturnValueOnce(answer);
    store.upload({ folder: '/home/anna', files: [file('a.txt'), file('b.txt')], replace: false });
    store.upload({ folder: '/srv', files: [file('c.txt')], replace: false });
    answer.error(httpError(403, 'linux_session_required'));
    expect(api.upload).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(linuxSessionStore.session()).toBeNull();
    expect(store.uploads()).toEqual([]);
    expect(finished).toEqual([]);
  });

  it('another Linux account signed in: the uploads and questions of the one before go', async () => {
    const { api, store } = await setup();
    const linuxSessionStore = TestBed.inject(LinuxSessionStore);
    linuxSessionStore.check();
    await vi.waitFor(() => expect(linuxSessionStore.session()).toEqual(ANNA));
    TestBed.tick();
    api.upload
      .mockReturnValueOnce(throwError(() => httpError(409, 'file_exists')))
      .mockReturnValueOnce(new Subject<number>());
    store.upload({ folder: '/home/anna', files: [file('notes.txt')], replace: false });
    const running = api.upload.mock.results.length;
    store.upload({ folder: '/home/anna', files: [file('a.txt'), file('b.txt')], replace: false });
    expect(store.clashes()).toHaveLength(1);
    api.session.mockReturnValue(
      of({ session: { username: 'bob', home: '/home/bob', uid: 1501, sudoUntil: null } }),
    );
    linuxSessionStore.check();
    await vi.waitFor(() => expect(linuxSessionStore.session()?.username).toBe('bob'));
    TestBed.tick();
    expect(store.uploads()).toEqual([]);
    expect(store.clashes()).toEqual([]);
    expect(api.upload).toHaveBeenCalledTimes(running + 1);
  });

  it('a batch whose files all failed: no reload asked for', async () => {
    const { api, store, finished } = await setup();
    vi.spyOn(toast, 'error');
    api.upload.mockReturnValue(throwError(() => httpError(403, 'permission_denied')));
    store.upload({ folder: '/etc', files: [file('a.txt'), file('b.txt')], replace: false });
    expect(finished).toEqual([]);
  });

  it('reset during an upload: the request ends, nothing is patched after, the queue is dropped', async () => {
    const { api, store, finished } = await setup();
    const running = new Subject<number>();
    api.upload.mockReturnValueOnce(running);
    store.upload({ folder: '/home/anna', files: [file('a.txt'), file('b.txt')], replace: false });
    store.upload({ folder: '/srv', files: [file('c.txt')], replace: false });
    store.reset();
    expect(running.observed).toBe(false);
    running.next(1);
    running.complete();
    expect(store.uploads()).toEqual([]);
    expect(api.upload).toHaveBeenCalledTimes(1);
    expect(finished).toEqual([]);
  });

  it('signing out of the app resets it', async () => {
    const { api, store } = await setup();
    const running = new Subject<number>();
    api.upload.mockReturnValueOnce(running);
    store.upload({ folder: '/home/anna', files: [file('a.txt')], replace: false });
    TestBed.inject(AuthStore).logout();
    await vi.waitFor(() => expect(store.uploads()).toEqual([]));
    expect(running.observed).toBe(false);
  });

  it('the list clears only once nothing is on its way', async () => {
    const { api, store } = await setup();
    const running = new Subject<number>();
    api.upload.mockReturnValueOnce(running);
    store.upload({ folder: '/home/anna', files: [file('a.txt')], replace: false });
    store.clear();
    expect(store.uploads()).toHaveLength(1);
    running.complete();
    store.clear();
    expect(store.uploads()).toEqual([]);
  });
});
