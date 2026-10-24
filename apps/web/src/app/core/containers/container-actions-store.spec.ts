import { HttpErrorResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { toast } from '@spartan-ng/brain/sonner';
import { NEVER, of, Subject, throwError } from 'rxjs';
import { AuthStore } from '../auth/auth-store';
import { fakeAuthApi, OWNER } from '../auth/testing';
import { LanguageService } from '../i18n/language';
import { ContainerActionsStore } from './container-actions-store';
import { ContainersApi } from './containers-api';

async function setup({ rtl = false } = {}) {
  const api = { act: vi.fn(() => of(null)) };
  const auth = fakeAuthApi({ user: OWNER });
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: 'login', children: [] }]),
      auth.provider,
      { provide: ContainersApi, useValue: api },
      ...(rtl
        ? [{ provide: LanguageService, useValue: { language: signal('ar'), dir: signal('rtl') } }]
        : []),
    ],
  });
  await TestBed.inject(AuthStore).load();
  const store = TestBed.inject(ContainerActionsStore);
  TestBed.tick();
  const success = vi.spyOn(toast, 'success').mockReturnValue(0);
  const error = vi.spyOn(toast, 'error').mockReturnValue(0);
  return { store, api, success, error };
}

describe('ContainerActionsStore', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps the name left to right inside a right-to-left toast', async () => {
    const { store, success } = await setup({ rtl: true });
    store.run({ name: 'jellyfin', action: 'stop' });
    // The words are English here (the test's language file); the isolate is what's checked.
    expect(success).toHaveBeenCalledWith('\u2066jellyfin\u2069 stopped');
  });

  it('runs an action, marks the container as busy meanwhile, then says so', async () => {
    const { store, api, success } = await setup();
    const answer = new Subject<null>();
    api.act.mockReturnValueOnce(answer);
    store.run({ name: 'jellyfin', action: 'stop' });
    expect(api.act).toHaveBeenCalledWith('jellyfin', 'stop');
    expect(store.pending()).toEqual(new Map([['jellyfin', 'stop']]));

    // A second action for the same container while one runs is ignored.
    store.run({ name: 'jellyfin', action: 'restart' });
    expect(api.act).toHaveBeenCalledTimes(1);

    answer.next(null);
    answer.complete();
    expect(store.pending()).toEqual(new Map());
    expect(success).toHaveBeenCalledWith(`jellyfin stopped`);
  });

  it.each([
    [
      { status: 403, error: { message: 'x', code: 'container_protected' } },
      'This container is part of the platform itself and can’t be stopped or restarted here.',
    ],
    [
      { status: 503, error: { message: 'x', code: 'docker_unavailable' } },
      'Docker isn’t reachable right now. Make sure it’s running and try again.',
    ],
    [{ status: 429 }, 'Too many attempts. Try again later.'],
    [{ status: 0 }, 'Couldn’t reach the server. Check your connection and try again.'],
    [{ status: 500, error: 'oops' }, 'Something went wrong (500).'],
  ])('says in plain words why an action failed (%o)', async (response, text) => {
    const { store, api, error } = await setup();
    api.act.mockReturnValueOnce(throwError(() => new HttpErrorResponse(response)));
    store.run({ name: 'old-app', action: 'start' });
    expect(error).toHaveBeenCalledWith(`Couldn't start old-app`, {
      description: text.replaceAll('’', "'"),
    });
    expect(store.pending()).toEqual(new Map());
  });

  it('is reset on sign-out', async () => {
    const { store, api } = await setup();
    api.act.mockReturnValueOnce(NEVER);
    store.run({ name: 'jellyfin', action: 'stop' });
    expect(store.pending().size).toBe(1);
    await TestBed.inject(AuthStore).logout();
    TestBed.tick();
    expect(store.pending().size).toBe(0);
  });
});
