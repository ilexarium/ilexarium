import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { Language } from '@homelab/i18n';
import { LanguageService } from '../i18n/language';
import { provideRouter, Router } from '@angular/router';
import { AuthStore } from './auth-store';
import { fakeAuthApi, fakeSignOutChannel, OWNER } from './testing';

function setup(server: Parameters<typeof fakeAuthApi>[0]) {
  const fake = fakeAuthApi(server);
  const tabs = fakeSignOutChannel();
  TestBed.configureTestingModule({
    providers: [provideRouter([]), fake.provider, tabs.provider],
  });
  return { store: TestBed.inject(AuthStore), tabs, ...fake };
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

  describe('the account’s language', () => {
    function withLanguages(server: Parameters<typeof fakeAuthApi>[0]) {
      const fake = fakeAuthApi(server);
      const language = signal<Language>('en');
      const languages = {
        language: language.asReadonly(),
        setLanguage: vi.fn(async (next: Language) => language.set(next)),
      };
      TestBed.configureTestingModule({
        providers: [
          provideRouter([]),
          fake.provider,
          { provide: LanguageService, useValue: languages },
        ],
      });
      return { store: TestBed.inject(AuthStore), languages };
    }

    it('is applied at startup when it differs from the one shown', async () => {
      const { store, languages } = withLanguages({ user: { ...OWNER, language: 'ar' } });
      await store.load();
      expect(languages.setLanguage).toHaveBeenCalledWith('ar');
    });

    it('is applied at sign-in', () => {
      const { store, languages } = withLanguages({});
      store.signedIn({ ...OWNER, language: 'de' });
      expect(languages.setLanguage).toHaveBeenCalledWith('de');
    });

    it('leaves the browser’s choice alone when the account has none, or the same', async () => {
      const { store, languages } = withLanguages({ user: { ...OWNER, language: 'en' } });
      await store.load();
      store.signedIn(OWNER);
      expect(languages.setLanguage).not.toHaveBeenCalled();
    });
  });

  it('updated() takes the user a profile change returned, only while signed in', async () => {
    const { store } = setup({ user: OWNER });
    await store.load();
    store.updated({ ...OWNER, displayName: 'Anna' });
    expect(store.user()?.displayName).toBe('Anna');
    store.sessionEnded();
    store.updated({ ...OWNER, displayName: 'Ghost' });
    expect(store.user()).toBeNull();
  });

  it('logoutEverywhere(): the socket’s 4401 on the way isn’t taken for an expiry', async () => {
    const { store, api } = setup({ user: OWNER });
    await store.load();
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    api.logoutEverywhere.mockImplementation(async () => {
      store.sessionExpired(); // what RealtimeService does on the 4401
      return null;
    });
    await store.logoutEverywhere();
    expect(navigate).not.toHaveBeenCalled(); // no /login?reason=expired
    expect(store.user()).toBeNull();
  });

  it('logoutEverywhere() ends every session on the server, clears the user and goes to /login', async () => {
    const { store, api } = setup({ user: OWNER });
    await store.load();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    await store.logoutEverywhere();
    expect(api.logoutEverywhere).toHaveBeenCalled();
    expect(store.user()).toBeNull();
    expect(navigate).toHaveBeenCalledWith('/login');
  });

  describe('other tabs', () => {
    it('are told before the server call (their sockets close meanwhile)', async () => {
      const { store, api, tabs } = setup({ user: OWNER });
      await store.load();
      vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
      api.logout.mockImplementationOnce(async () => {
        expect(tabs.channel.postMessage).toHaveBeenCalledOnce();
        return null;
      });
      await store.logout();
      expect(api.logout).toHaveBeenCalledOnce();
    });

    it('are told about a sign-out, also when the server call fails', async () => {
      const { store, api, tabs } = setup({ user: OWNER });
      await store.load();
      vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
      await store.logout();
      api.logout.mockRejectedValueOnce(new Error('offline'));
      await store.logout().catch(() => undefined);
      await store.logoutEverywhere();
      expect(tabs.channel.postMessage).toHaveBeenCalledTimes(3);
    });

    it('signing out ends this tab’s session too, remembering where it was', async () => {
      const { store, tabs } = setup({ user: OWNER });
      await store.load();
      const router = TestBed.inject(Router);
      vi.spyOn(router, 'url', 'get').mockReturnValue('/backups');
      const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
      tabs.receive();
      expect(store.status()).toBe('anonymous');
      expect(navigate).toHaveBeenCalledWith(['/login'], {
        queryParams: { returnUrl: '/backups' },
      });
    });

    it('signing out changes nothing in a tab that isn’t signed in', async () => {
      const { store, tabs } = setup({ needsSetup: true });
      await store.load();
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      tabs.receive();
      expect(store.needsSetup()).toBe(true);
      expect(navigate).not.toHaveBeenCalled();
    });
  });
});
