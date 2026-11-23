import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { Language } from '@ilex/i18n';
import type { PublicUser } from '@ilex/shared';
import { of } from 'rxjs';
import { AlertsStore } from '../../core/alerts/alerts-store';
import { alertsStatus, testAlert } from '../../core/alerts/testing';
import { AuthStore } from '../../core/auth/auth-store';
import { fakeAuthApi, OWNER } from '../../core/auth/testing';
import { LanguageService } from '../../core/i18n/language';
import { ProfileApi } from '../../core/profile/profile-api';
import { TopBar } from './top-bar';

/** Stands in for the language service with all three languages available. */
function fakeLanguages() {
  const language = signal<Language>('en');
  return {
    language: language.asReadonly(),
    dir: signal<'ltr' | 'rtl'>('ltr').asReadonly(),
    available: ['en', 'de', 'ar'] as Language[],
    setLanguage: vi.fn((next: Language) => of(language.set(next))),
  };
}

describe('TopBar user menu', () => {
  let languages: ReturnType<typeof fakeLanguages>;
  let profiles: { update: ReturnType<typeof vi.fn> };

  afterEach(() => document.querySelectorAll('.cdk-overlay-container').forEach((el) => el.remove()));

  async function openMenu(user: PublicUser = OWNER) {
    languages = fakeLanguages();
    profiles = {
      update: vi.fn((body: { language: Language }) => of({ user: { ...user, ...body } })),
    };
    const auth = fakeAuthApi({ user });
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        auth.provider,
        { provide: LanguageService, useValue: languages },
        { provide: ProfileApi, useValue: profiles },
      ],
    });
    await TestBed.inject(AuthStore).load();
    const fixture = TestBed.createComponent(TopBar);
    await fixture.whenStable();
    const trigger = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      'button[aria-label="Account menu"]',
    )!;
    trigger.click();
    await fixture.whenStable();
    const menu = () => document.querySelector<HTMLElement>('[data-slot="dropdown-menu"]')!;
    const items = () => [...menu().querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const item = (text: string) => items().find((el) => el.textContent!.includes(text))!;
    const radios = () => [
      ...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
    ];
    /** Opens the language submenu. */
    const openLanguages = async () => {
      item('Language').click();
      await fixture.whenStable();
    };
    return { fixture, trigger, menu, items, item, radios, openLanguages };
  }

  it('shows the username on the trigger and once in the header until there is a display name', async () => {
    const { fixture, menu } = await openMenu();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('owner');
    expect(menu().textContent!.match(/owner/g)).toHaveLength(1);
  });

  it('shows the username under the display name when there is no email address', async () => {
    const { menu } = await openMenu({ ...OWNER, displayName: 'Anna Berg' });
    expect(menu().querySelector('p[dir="ltr"]')!.textContent).toBe('owner');
  });

  it('shows the display name and the email address when set', async () => {
    const { fixture, menu } = await openMenu({
      ...OWNER,
      displayName: 'Anna Berg',
      email: 'anna@example.com',
      avatar: '/api/profile/avatar?v=1',
    });
    const host = fixture.nativeElement as HTMLElement;
    expect(host.textContent).toContain('Anna Berg');
    // jsdom loads no images: the avatar shows the initials (the picture is checked in a browser).
    expect(host.querySelector('ilex-user-avatar')!.textContent!.trim()).toBe('AB');
    expect(menu().textContent).toContain('Anna Berg');
    expect(menu().textContent).toContain('anna@example.com');
  });

  it('has Edit profile, My profile, Language and Sign out — all menu items', async () => {
    const { items, menu } = await openMenu();
    expect(items().map((el) => el.textContent!.replace(/\s+/g, ' ').trim())).toEqual([
      'Edit profile',
      'My profile',
      'Language English',
      'Sign out',
    ]);
    expect(menu().querySelector('a[href="/profile"]')).not.toBeNull();
  });

  it('signs out from the menu', async () => {
    const { fixture, item } = await openMenu();
    const logout = vi
      .spyOn(TestBed.inject(AuthStore), 'logout')
      .mockReturnValue({ destroy: () => undefined });
    item('Sign out').click();
    await fixture.whenStable();
    expect(logout).toHaveBeenCalled();
  });

  it('shows the email address left to right, whatever the language', async () => {
    const { menu } = await openMenu({ ...OWNER, email: 'anna@example.com' });
    const address = [...menu().querySelectorAll('p')].find((p) => p.textContent!.includes('@'))!;
    expect(address.getAttribute('dir')).toBe('ltr');
  });

  it('offers each language under its own name in a submenu, the current one checked', async () => {
    const { radios, openLanguages } = await openMenu();
    await openLanguages();
    expect(radios().map((el) => el.textContent!.trim())).toEqual(['English', 'Deutsch', 'العربية']);
    expect(radios().map((el) => el.getAttribute('lang'))).toEqual(['en', 'de', 'ar']);
    expect(radios().map((el) => el.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'false',
    ]);
  });

  it('leaves the language submenu open when Language is clicked again', async () => {
    const { radios, openLanguages } = await openMenu();
    await openLanguages();
    await openLanguages();
    expect(radios()).toHaveLength(3);
  });

  it('switches the language and keeps it for the account', async () => {
    const { fixture, radios, openLanguages } = await openMenu();
    await openLanguages();
    radios()[1].click();
    await fixture.whenStable();
    expect(languages.setLanguage).toHaveBeenCalledWith('de');
    expect(profiles.update).toHaveBeenCalledWith({ language: 'de' });
    expect(TestBed.inject(AuthStore).user()?.language).toBe('de');
  });

  it('opens the edit dialog from Edit profile', async () => {
    const { fixture, item } = await openMenu();
    item('Edit profile').click();
    await fixture.whenStable();
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Edit profile');
  });
});

describe('TopBar alerts bell', () => {
  afterEach(() => document.querySelectorAll('.cdk-overlay-container').forEach((el) => el.remove()));

  it('shows the open alerts on the bell, which opens the alerts menu', async () => {
    const auth = fakeAuthApi({ user: OWNER });
    TestBed.configureTestingModule({ providers: [provideRouter([]), auth.provider] });
    await TestBed.inject(AuthStore).load();
    const fixture = TestBed.createComponent(TopBar);
    TestBed.inject(AlertsStore).fill(
      alertsStatus({ open: [testAlert({ severity: 'warning' }), testAlert()] }),
    );
    await fixture.whenStable();
    const bell = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      'ilex-alerts-menu button',
    )!;
    expect(bell.getAttribute('aria-label')).toBe('Alerts: 2 open');
    bell.click();
    await fixture.whenStable();
    expect(document.querySelector('[data-slot="dropdown-menu"]')!.textContent).toContain('immich');
  });
});
