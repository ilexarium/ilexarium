import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { AuthStore } from './auth-store';
import { fakeAuthApi, OWNER } from './testing';

function setup(server: Parameters<typeof fakeAuthApi>[0]) {
  const fake = fakeAuthApi(server);
  TestBed.configureTestingModule({ providers: [provideRouter([]), fake.provider] });
  return { store: TestBed.inject(AuthStore), ...fake };
}

describe('AuthStore', () => {
  it('starts unknown', () => {
    expect(setup({}).store.status()).toBe('unknown');
  });

  it('load(): signed in', async () => {
    const { store } = setup({ user: OWNER });
    await store.load();
    expect(store.status()).toBe('authenticated');
    expect(store.isAuthenticated()).toBe(true);
    expect(store.user()).toEqual(OWNER);
  });

  it('load(): signed out ({ user: null } is not an error)', async () => {
    const { store } = setup({ user: null });
    await store.load();
    expect(store.status()).toBe('anonymous');
    expect(store.user()).toBeNull();
  });

  it('load(): fresh install', async () => {
    const { store } = setup({ needsSetup: true });
    await store.load();
    expect(store.needsSetup()).toBe(true);
  });

  it('load(): an unreachable server is never treated as signed out', async () => {
    const { store } = setup({ down: true });
    await expect(store.load()).resolves.toBeUndefined();
    expect(store.status()).toBe('unreachable');
  });

  it('signedIn() after login or setup clears needsSetup', async () => {
    const { store } = setup({ needsSetup: true });
    await store.load();
    store.signedIn(OWNER);
    expect(store.status()).toBe('authenticated');
    expect(store.needsSetup()).toBe(false);
  });

  it('logout() signs out on the server, clears the user and goes to /login', async () => {
    const { store, api } = setup({ user: OWNER });
    await store.load();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    await store.logout();
    expect(api.logout).toHaveBeenCalledOnce();
    expect(store.user()).toBeNull();
    expect(store.status()).toBe('anonymous');
    expect(navigate).toHaveBeenCalledWith('/login');
  });

  it('logout() clears locally even if the server call fails', async () => {
    const { store, api } = setup({ user: OWNER });
    await store.load();
    api.logout.mockRejectedValueOnce(new Error('offline'));
    vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    await store.logout().catch(() => undefined);
    expect(store.user()).toBeNull();
  });
});
