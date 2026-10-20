import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { Language } from '@homelab/i18n';
import { LanguageService } from '../i18n/language';
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

  it('logoutEverywhere() ends every session on the server, clears the user and goes to /login', async () => {
    const { store, api } = setup({ user: OWNER });
    await store.load();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    await store.logoutEverywhere();
    expect(api.logoutEverywhere).toHaveBeenCalled();
    expect(store.user()).toBeNull();
    expect(navigate).toHaveBeenCalledWith('/login');
  });
});
