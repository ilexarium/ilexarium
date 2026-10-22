import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { toast } from '@spartan-ng/brain/sonner';
import { AuthStore } from '../auth/auth-store';
import { fakeAuthApi, OWNER } from '../auth/testing';
import { ContainerActionsStore } from './container-actions-store';
import { ContainersApi } from './containers-api';

/** A name kept left to right inside a translated toast. */

async function setup() {
  const api = { act: vi.fn(async () => null) };
  const auth = fakeAuthApi({ user: OWNER });
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: 'login', children: [] }]),
      auth.provider,
      { provide: ContainersApi, useValue: api },
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

  it('runs an action, marks the container as busy meanwhile, then says so', async () => {
    const { store, api, success } = await setup();
    let finish!: () => void;
    api.act.mockImplementationOnce(() => new Promise((resolve) => (finish = () => resolve(null))));
    const running = store.run('jellyfin', 'stop');
    expect(api.act).toHaveBeenCalledWith('jellyfin', 'stop');
    expect(store.pending()).toEqual(new Map([['jellyfin', 'stop']]));

    // A second action for the same container while one runs is ignored.
    await store.run('jellyfin', 'restart');
    expect(api.act).toHaveBeenCalledTimes(1);

    finish();
    await running;
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
    api.act.mockRejectedValueOnce(new HttpErrorResponse(response));
    await store.run('old-app', 'start');
    expect(error).toHaveBeenCalledWith(`Couldn't start old-app`, {
      description: text.replaceAll('’', "'"),
    });
    expect(store.pending()).toEqual(new Map());
  });

  it('is reset on sign-out', async () => {
    const { store, api } = await setup();
    api.act.mockImplementationOnce(() => new Promise(() => undefined)); // never settles
    void store.run('jellyfin', 'stop');
    expect(store.pending().size).toBe(1);
    await TestBed.inject(AuthStore).logout();
    TestBed.tick();
    expect(store.pending().size).toBe(0);
  });
});
