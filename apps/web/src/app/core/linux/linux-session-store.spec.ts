import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { LinuxSession } from '@laris/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { of, throwError } from 'rxjs';
import { AuthStore } from '../auth/auth-store';
import { fakeAuthApi, OWNER } from '../auth/testing';
import { FilesApi } from '../files/files-api';
import { LinuxSessionStore } from './linux-session-store';

const ANNA: LinuxSession = { username: 'anna', home: '/home/anna', uid: 1500, sudoUntil: null };
const unlockedFor = (ms: number): LinuxSession => ({
  ...ANNA,
  sudoUntil: new Date(Date.now() + ms).toISOString(),
});
const httpError = (status: number, code: string) =>
  new HttpErrorResponse({ status, error: { message: 'x', code } });

async function setup(session: LinuxSession | null = ANNA) {
  const filesApi = {
    session: vi.fn(() => of({ session })),
    signIn: vi.fn(() => of(ANNA)),
    signOut: vi.fn(() => of(undefined)),
    unlockSudo: vi.fn(() => of(unlockedFor(15 * 60_000))),
    lockSudo: vi.fn(() => of({ session: { ...ANNA, sudoUntil: null } })),
  };
  const auth = fakeAuthApi({ user: OWNER });
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: 'login', children: [] }]),
      auth.provider,
      { provide: FilesApi, useValue: filesApi },
    ],
  });
  const authStore = TestBed.inject(AuthStore);
  await authStore.load();
  const store = TestBed.inject(LinuxSessionStore);
  TestBed.tick();
  store.check();
  vi.spyOn(toast, 'success').mockReturnValue(0);
  vi.spyOn(toast, 'error').mockReturnValue(0);
  return { store, filesApi, authStore };
}

describe('LinuxSessionStore', () => {
  afterEach(() => vi.restoreAllMocks());

  it('asks for the sudo password while locked, then runs the action', async () => {
    const { store, filesApi } = await setup();
    const action = vi.fn(async () => 'done');
    const result = store.withSudo(action);
    expect(store.sudoPrompt()).toBe(true);
    expect(action).not.toHaveBeenCalled();
    await store.unlockSudo('pw');
    expect(await result).toBe('done');
    expect(filesApi.unlockSudo).toHaveBeenCalledWith({ password: 'pw' });
    expect(store.sudoPrompt()).toBe(false);
    expect(store.sudoMinutes()).toBe(15);
  });

  it('runs at once while unlocked', async () => {
    const { store } = await setup(unlockedFor(5 * 60_000));
    expect(await store.withSudo(async () => 'done')).toBe('done');
    expect(store.sudoPrompt()).toBe(false);
  });

  it('a cancelled prompt runs nothing', async () => {
    const { store } = await setup();
    const action = vi.fn(async () => 'done');
    const result = store.withSudo(action);
    store.cancelSudo();
    expect(await result).toBeNull();
    expect(action).not.toHaveBeenCalled();
  });

  it('sudo ran out meanwhile (the estimate was wrong): asked again, the action once more', async () => {
    const { store } = await setup(unlockedFor(5 * 60_000));
    const action = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(httpError(403, 'sudo_required'))
      .mockResolvedValueOnce('done');
    const result = store.withSudo(action);
    await vi.waitFor(() => expect(store.sudoPrompt()).toBe(true));
    expect(store.sudoMinutes()).toBeNull();
    await store.unlockSudo('pw');
    expect(await result).toBe('done');
    expect(action).toHaveBeenCalledTimes(2);
  });

  it('each use restarts the minutes left, like sudo’s own time', async () => {
    const { store } = await setup(unlockedFor(3 * 60_000));
    expect(store.sudoMinutes()).toBeLessThan(5);
    await store.withSudo(async () => 'done');
    expect(store.sudoMinutes()).toBe(15);
  });

  it('a late “closed” of an earlier prompt never cancels the one asked now', async () => {
    const { store } = await setup(unlockedFor(5 * 60_000));
    const action = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(httpError(403, 'sudo_required'))
      .mockResolvedValueOnce('done');
    const result = store.withSudo(action);
    await vi.waitFor(() => expect(store.sudoPrompt()).toBe(true));
    const first = store.sudoPromptId();
    store.cancelSudo(first - 1);
    expect(store.sudoPrompt()).toBe(true);
    await store.unlockSudo('pw');
    store.cancelSudo(first);
    expect(await result).toBe('done');
  });

  it('passes on an action’s other errors', async () => {
    const { store } = await setup(unlockedFor(5 * 60_000));
    const failure = httpError(403, 'process_not_permitted');
    await expect(store.withSudo(() => Promise.reject(failure))).rejects.toBe(failure);
  });

  it('a wrong password keeps the prompt open, rejecting for the form', async () => {
    const { store, filesApi } = await setup();
    const result = store.withSudo(async () => 'done');
    filesApi.unlockSudo.mockReturnValueOnce(
      throwError(() => httpError(403, 'sudo_password_wrong')),
    );
    await expect(store.unlockSudo('wrong')).rejects.toBeInstanceOf(HttpErrorResponse);
    expect(store.sudoPrompt()).toBe(true);
    await store.unlockSudo('right');
    expect(await result).toBe('done');
  });

  it('counts the minutes left in whole minutes, rounded up', async () => {
    const { store } = await setup(unlockedFor(4 * 60_000 + 1_000));
    expect(store.sudoMinutes()).toBe(5);
  });

  it('“Lock now” locks sudo; the Linux session stays', async () => {
    const { store, filesApi } = await setup(unlockedFor(5 * 60_000));
    await store.lockNow();
    expect(filesApi.lockSudo).toHaveBeenCalled();
    expect(store.session()).toMatchObject({ username: 'anna', sudoUntil: null });
    expect(store.sudoMinutes()).toBeNull();
  });

  it('forgets everything at the app’s sign-out, a waiting prompt answered “no”', async () => {
    const { store, authStore } = await setup(unlockedFor(5 * 60_000));
    store.ended();
    const result = store.withSudo(async () => 'done');
    await authStore.logout();
    TestBed.tick();
    expect(await result).toBeNull();
    expect(store.session()).toBeNull();
    expect(store.checked()).toBe(false);
    expect(store.sudoPrompt()).toBe(false);
  });
});
