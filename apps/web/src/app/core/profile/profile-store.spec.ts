import { HttpErrorResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { Language } from '@ilex/i18n';
import type { ProfileUpdate } from '@ilex/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { throwError, of } from 'rxjs';
import { AuthStore } from '../auth/auth-store';
import { fakeAuthApi, OWNER } from '../auth/testing';
import { LanguageService } from '../i18n/language';
import { ProfileApi } from './profile-api';
import { ProfileStore } from './profile-store';

async function setup(signedIn = true) {
  const language = signal<Language>('en');
  const languages = {
    language: language.asReadonly(),
    setLanguage: vi.fn((next: Language) => of(language.set(next))),
  };
  const api = {
    update: vi.fn((body: ProfileUpdate) => of({ user: { ...OWNER, ...body } })),
  };
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      fakeAuthApi({ user: signedIn ? OWNER : null }).provider,
      { provide: LanguageService, useValue: languages },
      { provide: ProfileApi, useValue: api },
    ],
  });
  await TestBed.inject(AuthStore).load();
  return { store: TestBed.inject(ProfileStore), auth: TestBed.inject(AuthStore), languages, api };
}

describe('ProfileStore.chooseLanguage', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows the language and keeps it for the account', async () => {
    const { store, auth, languages, api } = await setup();
    store.chooseLanguage('ar');
    expect(languages.setLanguage).toHaveBeenCalledWith('ar');
    expect(api.update).toHaveBeenCalledWith({ language: 'ar' });
    expect(auth.user()?.language).toBe('ar');
  });

  it('doesn’t save it again when the account has it already', async () => {
    const { store, auth, api } = await setup();
    auth.updated({ ...OWNER, language: 'de' });
    store.chooseLanguage('de');
    expect(api.update).not.toHaveBeenCalled();
  });

  it('only shows it when nobody is signed in', async () => {
    const { store, languages, api } = await setup(false);
    store.chooseLanguage('de');
    expect(languages.setLanguage).toHaveBeenCalledWith('de');
    expect(api.update).not.toHaveBeenCalled();
  });

  it('says so when the language’s file doesn’t load, and saves nothing', async () => {
    const { store, languages, api } = await setup();
    const error = vi.spyOn(toast, 'error');
    languages.setLanguage.mockReturnValueOnce(throwError(() => new Error('chunk failed')));
    store.chooseLanguage('ar');
    expect(api.update).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith('The language couldn’t be loaded', expect.anything());
  });

  it('keeps showing it, and says so, when the account can’t be updated', async () => {
    const { store, languages, api } = await setup();
    const error = vi.spyOn(toast, 'error');
    api.update.mockReturnValueOnce(throwError(() => new HttpErrorResponse({ status: 0 })));
    store.chooseLanguage('de');
    expect(languages.language()).toBe('de');
    expect(error).toHaveBeenCalledWith(
      'The language couldn’t be saved for your account',
      expect.anything(),
    );
  });
});
