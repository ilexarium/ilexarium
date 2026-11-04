import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthStore } from '../auth/auth-store';
import { fakeAuthApi, OWNER } from '../auth/testing';
import { PAGE_RELOAD } from './page-reload';
import { updatesStatus } from './testing';
import { UpdatesStore } from './updates-store';

describe('UpdatesStore', () => {
  function setup() {
    const reload = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'login', children: [] }]),
        { provide: PAGE_RELOAD, useValue: reload },
        fakeAuthApi({ user: OWNER }).provider,
      ],
    });
    return { store: TestBed.inject(UpdatesStore), reload };
  }

  it('keeps the status, with a newer release as available', () => {
    const { store, reload } = setup();
    store.update(updatesStatus({ available: { version: '0.2.0', published: '', notes: null } }));
    expect(store.available()?.version).toBe('0.2.0');
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads the page when the server comes back as another version (its files are gone)', () => {
    const { store, reload } = setup();
    store.update(updatesStatus({ installed: '0.1.0' }));
    store.update(updatesStatus({ installed: '0.1.0', checkAutomatically: false }));
    expect(reload).not.toHaveBeenCalled();
    store.update(updatesStatus({ installed: '0.2.0' }));
    expect(reload).toHaveBeenCalledOnce();
  });

  it('still reloads when the update finished while signed out', async () => {
    const { store, reload } = setup();
    const authStore = TestBed.inject(AuthStore);
    await authStore.load();
    store.update(updatesStatus({ installed: '0.1.0' }));
    await authStore.logout();
    TestBed.tick();
    expect(store.status()).toBeNull();
    store.update(updatesStatus({ installed: '0.2.0' }));
    expect(reload).toHaveBeenCalledOnce();
  });
});
