import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { LinuxSession } from '@ilex/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { defer, firstValueFrom, of, throwError } from 'rxjs';
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

/** An action that answers `results` in turn, an HTTP error being a refusal. */
const answering = (...results: (string | HttpErrorResponse)[]) =>
  vi.fn(() =>
    defer(() => {
      const next = results.shift();
      return next instanceof HttpErrorResponse ? throwError(() => next) : of(next);
    }),
  );

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
    const action = answering('done');
    const result = firstValueFrom(store.withSudo$(action));
    expect(store.sudoPrompt()).toBe(true);
    expect(action).not.toHaveBeenCalled();
    await store.unlockSudo('pw');
    expect(await result).toBe('done');
    expect(filesApi.unlockSudo).toHaveBeenCalledWith({ password: 'pw' });
    expect(store.sudoPrompt()).toBe(false);
    expect(store.sudoMinutes()).toBe(15);
  });

  it('each use restarts the minutes left, like sudo’s own time', async () => {
    const { store } = await setup(unlockedFor(3 * 60_000));
    expect(store.sudoMinutes()).toBeLessThan(5);
    await firstValueFrom(store.withSudo$(() => of('done')));
    expect(store.sudoMinutes()).toBe(15);
  });

  it('a late “closed” of an earlier prompt never cancels the one asked now', async () => {
    const { store } = await setup(unlockedFor(5 * 60_000));
    const result = firstValueFrom(
      store.withSudo$(answering(httpError(403, 'sudo_required'), 'done')),
    );
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
    await expect(firstValueFrom(store.withSudo$(() => throwError(() => failure)))).rejects.toBe(
      failure,
    );
  });

  it('a wrong password keeps the prompt open, rejecting for the form', async () => {
    const { store, filesApi } = await setup();
    const result = firstValueFrom(store.withSudo$(() => of('done')));
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
    const result = firstValueFrom(store.withSudo$(() => of('done')));
    authStore.logout();
    TestBed.tick();
    expect(await result).toBeNull();
    expect(store.session()).toBeNull();
    expect(store.checked()).toBe(false);
    expect(store.sudoPrompt()).toBe(false);
  });

  describe('as Observables', () => {
    it('asks nothing and runs nothing before it is subscribed', async () => {
      const { store } = await setup(null);
      const action = answering('done');
      const result = store.asPerson$(action);
      expect(store.signInPrompt()).toBe(false);
      expect(action).not.toHaveBeenCalled();
      result.subscribe();
      expect(store.signInPrompt()).toBe(true);
    });

    it('asPerson$: signed in first without a session, then the action', async () => {
      const { store, filesApi } = await setup(null);
      const action = answering('done');
      const result = firstValueFrom(store.asPerson$(action));
      expect(store.signInPrompt()).toBe(true);
      await store.signIn({ username: 'anna', password: 'pw' });
      store.signInClosed();
      expect(await result).toBe('done');
      expect(store.signInPrompt()).toBe(false);
      // sudo may have been used: the session read again for its minutes.
      expect(filesApi.session).toHaveBeenCalledTimes(2);
    });

    it('asPerson$: the sign-in closed — null, once, and nothing sent', async () => {
      const { store } = await setup(null);
      const action = answering('done');
      const result = firstValueFrom(store.asPerson$(action));
      store.signInClosed();
      expect(await result).toBeNull();
      expect(action).not.toHaveBeenCalled();
    });

    it('asPerson$: sudo needed and locked — the password asked, then the action once more', async () => {
      const { store } = await setup(unlockedFor(5 * 60_000));
      const action = answering(httpError(403, 'sudo_required'), 'done');
      const result = firstValueFrom(store.asPerson$(action));
      await vi.waitFor(() => expect(store.sudoPrompt()).toBe(true));
      expect(store.sudoMinutes()).toBeNull();
      await store.unlockSudo('pw');
      expect(await result).toBe('done');
      expect(action).toHaveBeenCalledTimes(2);
    });

    it('asPerson$: signed in here and then sudo needed — unlocked with the same password, no second prompt', async () => {
      const { store, filesApi } = await setup(null);
      const action = answering(httpError(403, 'sudo_required'), 'done');
      const result = firstValueFrom(store.asPerson$(action));
      await store.signIn({ username: 'anna', password: 'pw' });
      store.signInClosed();
      expect(await result).toBe('done');
      expect(filesApi.unlockSudo).toHaveBeenCalledWith({ password: 'pw' });
      expect(store.sudoPrompt()).toBe(false);
      expect(action).toHaveBeenCalledTimes(2);
    });

    it('asPerson$: the unlock with the sign-in’s password refused — the action’s error, no sudo prompt', async () => {
      const { store, filesApi } = await setup(null);
      const refused = httpError(403, 'sudo_failed');
      filesApi.unlockSudo.mockReturnValue(throwError(() => refused));
      const action = answering(httpError(403, 'sudo_required'), 'done');
      const result = firstValueFrom(store.asPerson$(action));
      await store.signIn({ username: 'anna', password: 'pw' });
      store.signInClosed();
      await expect(result).rejects.toBe(refused);
      expect(store.sudoPrompt()).toBe(false);
      expect(action).toHaveBeenCalledTimes(1);
    });

    it('asPerson$: the sign-in’s password is used once — sudo needed again asks', async () => {
      const { store, filesApi } = await setup(null);
      const sudo = () => httpError(403, 'sudo_required');
      const action = answering(sudo(), sudo(), 'done');
      const result = firstValueFrom(store.asPerson$(action));
      await store.signIn({ username: 'anna', password: 'pw' });
      store.signInClosed();
      await vi.waitFor(() => expect(store.sudoPrompt()).toBe(true));
      expect(filesApi.unlockSudo).toHaveBeenCalledTimes(1);
      await store.unlockSudo('typed again');
      expect(await result).toBe('done');
    });

    it('asPerson$: already signed in — sudo asked in its own prompt, as before', async () => {
      const { store, filesApi } = await setup(ANNA);
      const action = answering(httpError(403, 'sudo_required'), 'done');
      const result = firstValueFrom(store.asPerson$(action));
      await vi.waitFor(() => expect(store.sudoPrompt()).toBe(true));
      expect(filesApi.unlockSudo).not.toHaveBeenCalled();
      await store.unlockSudo('pw');
      expect(await result).toBe('done');
    });

    it('a sign-in outside the prompt (Files’ own) gives no password to a later action', async () => {
      const { store, filesApi } = await setup(null);
      await store.signIn({ username: 'anna', password: 'pw' });
      const action = answering(httpError(403, 'sudo_required'), 'done');
      const result = firstValueFrom(store.asPerson$(action));
      await vi.waitFor(() => expect(store.sudoPrompt()).toBe(true));
      expect(filesApi.unlockSudo).not.toHaveBeenCalled();
      await store.unlockSudo('pw');
      expect(await result).toBe('done');
    });

    it('asPerson$: the Linux session ended meanwhile — signed in again, then once more', async () => {
      const { store } = await setup();
      const action = answering(httpError(403, 'linux_session_required'), 'done');
      const result = firstValueFrom(store.asPerson$(action));
      expect(store.session()).toBeNull();
      expect(store.signInPrompt()).toBe(true);
      await store.signIn({ username: 'anna', password: 'pw' });
      store.signInClosed();
      expect(await result).toBe('done');
    });

    it('asPerson$: passes on other refusals, and gives up after three tries', async () => {
      const { store } = await setup(unlockedFor(5 * 60_000));
      const failure = httpError(409, 'app_task_running');
      await expect(firstValueFrom(store.asPerson$(answering(failure)))).rejects.toBe(failure);
      const sudo = () => httpError(403, 'sudo_required');
      const action = answering(sudo(), sudo(), sudo());
      const result = firstValueFrom(store.asPerson$(action));
      await store.unlockSudo('pw');
      await vi.waitFor(() => expect(store.sudoPrompt()).toBe(true));
      await store.unlockSudo('pw');
      await expect(result).rejects.toBeInstanceOf(HttpErrorResponse);
      expect(action).toHaveBeenCalledTimes(3);
    });

    it('unsubscribed while a prompt is asked (the page left): only an answer closes it', async () => {
      const { store } = await setup(null);
      const left = answering('a');
      const subscription = store.asPerson$(left).subscribe();
      subscription.unsubscribe();
      expect(store.signInPrompt()).toBe(true);
      await store.signIn({ username: 'anna', password: 'pw' });
      store.signInClosed();
      expect(store.signInPrompt()).toBe(false);
      expect(left).not.toHaveBeenCalled();
    });

    it('a prompt shared with another waiting action stays open when one leaves', async () => {
      const { store } = await setup();
      const left = store.withSudo$(answering('a')).subscribe();
      const staying = firstValueFrom(store.withSudo$(answering('b')));
      left.unsubscribe();
      expect(store.sudoPrompt()).toBe(true);
      await store.unlockSudo('pw');
      expect(await staying).toBe('b');
    });

    it('withSudo$: asked while locked, then run; at once while unlocked', async () => {
      const { store } = await setup();
      const result = firstValueFrom(store.withSudo$(answering('done')));
      expect(store.sudoPrompt()).toBe(true);
      await store.unlockSudo('pw');
      expect(await result).toBe('done');
      expect(store.sudoMinutes()).toBe(15);
      expect(await firstValueFrom(store.withSudo$(answering('again')))).toBe('again');
      expect(store.sudoPrompt()).toBe(false);
    });

    it('withSudo$: cancelled — null, nothing run', async () => {
      const { store } = await setup();
      const action = answering('done');
      const result = firstValueFrom(store.withSudo$(action));
      store.cancelSudo();
      expect(await result).toBeNull();
      expect(action).not.toHaveBeenCalled();
    });

    it('withSudo$: sudo ran out meanwhile — asked again, the action once more', async () => {
      const { store } = await setup(unlockedFor(5 * 60_000));
      const action = answering(httpError(403, 'sudo_required'), 'done');
      const result = firstValueFrom(store.withSudo$(action));
      await vi.waitFor(() => expect(store.sudoPrompt()).toBe(true));
      expect(store.sudoMinutes()).toBeNull();
      await store.unlockSudo('pw');
      expect(await result).toBe('done');
      expect(action).toHaveBeenCalledTimes(2);
    });
  });
});
